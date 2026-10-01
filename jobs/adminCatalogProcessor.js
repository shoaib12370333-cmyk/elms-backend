const cron = require('node-cron');
const AdminCatalogJob = require('../models/schemas/AdminCatalogJob');
const { withLease } = require('../services/jobLockService');
const { toEasyparserDomain, submitBulkDetail, pollResult, normalizeDetail } = require('../services/easyparserAmazonService');
const { setCachedProduct } = require('../services/productCacheService');

/**
 * Admin Panel > Product Catalog's background fetch run: the same submit-then-poll shape as
 * jobs/bulkImportProcessor.js (Easyparser's Bulk API), but much simpler - nobody is charged a credit, and a
 * successful item becomes a ProductCatalogItem row (models/productCatalogModel.js) instead of a Draft, with
 * its eBay category resolved once up front (services/aiCategoryService.js) so a later push to a seller's
 * Drafts needs no further AI call (when that seller's store is on the same marketplace - see
 * models/productCatalogModel.js pushCatalogItemToUserDrafts).
 */
const MAX_SUBMIT_ATTEMPTS = 5;
const ITEM_TIMEOUT_MS = 30 * 60 * 1000; // give up on a single item after 30 minutes of polling
const PER_MINUTE = Math.max(10, Number(process.env.EASYPARSER_PER_MINUTE) || 500);
const SUBMIT_BATCH_SIZE = Math.floor(PER_MINUTE * 0.9);
const POLL_BATCH_SIZE = PER_MINUTE;
const POLL_CONCURRENCY = 20;

function recount(job) {
  job.done = job.items.filter((i) => i.status === 'done').length;
  job.failed = job.items.filter((i) => i.status === 'error').length;
}

/** Submits the next slice (at most SUBMIT_BATCH_SIZE) of the not-yet-submitted items of one job to Easyparser in one bulk call. */
async function submitPendingItems(job) {
  const unsent = job.items.filter((i) => i.status === 'pending' && !i.queryId);
  if (!unsent.length) {
    job.status = 'polling';
    return;
  }
  const toSubmit = unsent.slice(0, SUBMIT_BATCH_SIZE);

  const byDomain = new Map();
  for (const item of toSubmit) {
    const domain = toEasyparserDomain(item.country);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(item.asin);
  }
  const itemsByDomain = [...byDomain.entries()].map(([domain, asins]) => ({ domain, asins: [...new Set(asins)] }));

  let result;
  try {
    result = await submitBulkDetail(itemsByDomain);
  } catch (err) {
    job.submitAttempts += 1;
    job.lastError = err.message;
    if (job.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
      for (const item of toSubmit) { item.status = 'error'; item.error = 'Could not submit to Easyparser: ' + err.message; }
      job.status = 'polling';
    }
    return;
  }

  const now = new Date();
  for (const accepted of result.accepted) {
    const item = toSubmit.find((i) => i.asin === accepted.asin && toEasyparserDomain(i.country) === accepted.domain && !i.queryId);
    if (item) { item.queryId = accepted.queryId; item.submittedAt = now; }
  }
  if (result.accepted.length) job.submitAttempts = 0;
  let waitingReason = null;
  for (const rejected of result.rejected) {
    const item = toSubmit.find((i) => i.asin === rejected.asin && toEasyparserDomain(i.country) === rejected.domain && !i.queryId);
    if (!item) continue;
    if (rejected.retryable) { waitingReason = rejected.reason; continue; }
    item.status = 'error';
    item.error = rejected.reason || 'Rejected by Easyparser.';
  }
  const waiting = toSubmit.filter((i) => i.status === 'pending' && !i.queryId);
  if (waiting.length) {
    if (!result.accepted.length) job.submitAttempts += 1;
    job.lastError = waitingReason || 'Easyparser did not take ' + waiting.length + ' product' + (waiting.length === 1 ? '' : 's') + ' yet; sending them again.';
    if (job.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
      for (const item of waiting) { item.status = 'error'; item.error = waitingReason || 'Easyparser did not take this product.'; }
    }
  }
  job.status = 'polling';
}

const hasUnsentItems = (job) => job.items.some((i) => i.status === 'pending' && !i.queryId);

async function reportProgress(job, hooks = {}) {
  recount(job);
  if (hooks.persistCounts) await hooks.persistCounts(job);
}

/** Resolves a category (best-effort) and saves the product as a catalog row. Never leaves the item unresolved: a category failure is recorded on the row, not treated as the whole item failing. */
async function trySave(job, item, product, saveCatalogItem, hooks = {}) {
  try {
    const catalogItem = await saveCatalogItem(job, item, product);
    item.status = 'done';
    item.catalogItemId = catalogItem.id;
    if (hooks.persistItem) await hooks.persistItem(job, item);
  } catch (err) {
    item.status = 'error';
    item.error = err.message || 'Could not save this product to the catalog.';
  }
}

/** Polls up to POLL_BATCH_SIZE outstanding items of one job. */
async function pollItems(job, saveCatalogItem, hooks = {}) {
  const outstanding = job.items.filter((i) => i.status === 'pending' && i.queryId).slice(0, POLL_BATCH_SIZE);
  const now = Date.now();

  for (let i = 0; i < outstanding.length; i += POLL_CONCURRENCY) {
    const chunk = outstanding.slice(i, i + POLL_CONCURRENCY);
    await Promise.allSettled(chunk.map(async (item) => {
      if (item.submittedAt && now - new Date(item.submittedAt).getTime() > ITEM_TIMEOUT_MS) {
        item.status = 'error';
        item.error = 'Timed out waiting for Easyparser.';
        return;
      }
      let result;
      try {
        result = await pollResult(item.queryId);
      } catch (err) {
        return; // transient - try again next tick
      }
      if (result.status === 'pending') return;
      if (result.status === 'failure') {
        item.status = 'error';
        item.error = result.error || 'Easyparser could not fetch this product.';
        return;
      }
      const product = normalizeDetail(result.raw, item.amazonUrl);
      if (product.asin) setCachedProduct(product.asin, item.country, product, 'easyparser').catch(() => {});
      await trySave(job, item, product, saveCatalogItem, hooks);
    }));
    if (hooks.renew) await hooks.renew();
    await reportProgress(job, hooks);
  }
}

async function processOneJob(job, saveCatalogItem, hooks = {}) {
  if (job.status === 'queued' || (job.status === 'polling' && hasUnsentItems(job))) await submitPendingItems(job);
  if (job.status === 'polling') await pollItems(job, saveCatalogItem, hooks);
  recount(job);
  const unresolved = job.items.some((i) => i.status === 'pending');
  if (job.status === 'polling' && !unresolved) {
    job.status = 'done';
    job.finishedAt = new Date();
  }
  job.lastProcessedAt = new Date();
  if (hooks.isCancelled && await hooks.isCancelled(job)) job.status = 'cancelled';
  await job.save();
}

async function isCancelled(job) {
  const row = await AdminCatalogJob.findById(job._id).select('status').lean();
  return !!row && row.status === 'cancelled';
}

async function persistItem(job, item) {
  try {
    await AdminCatalogJob.updateOne(
      { _id: job._id, items: { $elemMatch: { asin: item.asin, country: item.country } } },
      { $set: { 'items.$.status': 'done', 'items.$.catalogItemId': item.catalogItemId } }
    );
  } catch (err) {
    console.warn('[admin-catalog] could not write the progress of ' + item.asin + ': ' + err.message);
  }
}

async function persistCounts(job) {
  try {
    await AdminCatalogJob.updateOne({ _id: job._id, status: { $in: ['queued', 'polling'] } }, { $set: { done: job.done, failed: job.failed } });
  } catch (err) {
    console.warn('[admin-catalog] could not write the progress of job ' + job._id + ': ' + err.message);
  }
}

async function runAdminCatalogProcessor({ renew } = {}) {
  const { getLimits } = require('../models/settingsModel');
  const { createCatalogItem } = require('../models/productCatalogModel');
  const { pickCategory } = require('../services/aiCategoryService');
  const { catalogRetentionDays } = await getLimits();
  const expiresAt = new Date(Date.now() + catalogRetentionDays * 24 * 60 * 60 * 1000);

  // Charged to the admin who started the fetch (services/aiCategoryService.js has no "free" mode) - same AI_CATEGORY
  // cost as a seller's own "Fill category with AI", just paid by the admin building the catalog instead of a seller.
  // A failure here (no credits, AI off, no category list for this marketplace) never loses the fetched product data -
  // the row is still saved, uncategorized, and categoryError says why.
  const saveCatalogItem = async (job, item, product) => {
    let categoryId = null;
    let categoryName = null;
    let categoryError = null;
    try {
      const pick = await pickCategory(job.createdBy, product.title, job.marketplaceId);
      categoryId = pick.id;
      categoryName = pick.name;
    } catch (err) {
      categoryError = err.message || 'Could not resolve a category.';
    }
    return createCatalogItem({
      createdBy: job.createdBy,
      product,
      amazonUrl: item.amazonUrl,
      country: item.country,
      marketplaceId: job.marketplaceId,
      categoryId,
      categoryName,
      categoryError,
      expiresAt,
    });
  };

  const jobs = await AdminCatalogJob.find({ status: { $in: ['queued', 'polling'] } }).sort({ lastProcessedAt: 1 }).limit(10);
  for (const job of jobs) {
    try {
      await processOneJob(job, saveCatalogItem, { persistItem, persistCounts, isCancelled, renew });
    } catch (err) {
      console.error('[admin-catalog] job ' + job._id + ' failed:', err.message);
    }
    if (renew) await renew();
  }
}

function startAdminCatalogProcessor() {
  cron.schedule('* * * * *', async () => {
    try { await withLease('admin-catalog-processor', 10 * 60 * 1000, ({ renew }) => runAdminCatalogProcessor({ renew })); }
    catch (err) { console.error('[admin-catalog] Unexpected error:', err.message); }
  });
  console.log('[admin-catalog] Background admin catalog fetch processor scheduled (every minute).');
}

module.exports = { startAdminCatalogProcessor, runAdminCatalogProcessor, processOneJob };
