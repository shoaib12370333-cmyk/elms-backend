const cron = require('node-cron');
const BulkImportJob = require('../models/schemas/BulkImportJob');
const { acquireLock } = require('../services/jobLockService');
const { hasCredits } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { toEasyparserDomain, submitBulkDetail, pollResult, normalizeDetail } = require('../services/easyparserAmazonService');
const { setCachedProduct } = require('../services/productCacheService');

const MAX_SUBMIT_ATTEMPTS = 5;
const ITEM_TIMEOUT_MS = 30 * 60 * 1000; // give up on a single item after 30 minutes of polling
const POLL_BATCH_SIZE = 100; // items polled per tick (job runs once a minute - see startBulkImportProcessor)
const POLL_CONCURRENCY = 10;

/** A minimal stand-in for Express's `req`, only used by materializeImageUrls to build an
 * absolute image URL WHEN no BACKEND_PUBLIC_URL/RENDER_EXTERNAL_URL env var is set - on
 * Render (where RENDER_EXTERNAL_URL is set automatically) this is never actually touched. */
const FAKE_REQ = { protocol: 'https', get: () => process.env.RENDER_EXTERNAL_URL || 'localhost' };

function recount(job) {
  job.done = job.items.filter((i) => i.status === 'done').length;
  job.failed = job.items.filter((i) => i.status === 'error').length;
}

/** Submits every not-yet-submitted item of one job to Easyparser in a single bulk call. */
async function submitPendingItems(job) {
  const toSubmit = job.items.filter((i) => i.status === 'pending' && !i.queryId);
  if (!toSubmit.length) {
    job.status = 'polling';
    return;
  }

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
      job.status = 'polling'; // nothing left pending - the finish check below will close it out
    }
    return;
  }

  const now = new Date();
  for (const accepted of result.accepted) {
    const item = toSubmit.find((i) => i.asin === accepted.asin && toEasyparserDomain(i.country) === accepted.domain && !i.queryId);
    if (item) { item.queryId = accepted.queryId; item.submittedAt = now; }
  }
  let waitingReason = null;
  for (const rejected of result.rejected) {
    const item = toSubmit.find((i) => i.asin === rejected.asin && toEasyparserDomain(i.country) === rejected.domain && !i.queryId);
    if (!item) continue;
    if (rejected.retryable) { waitingReason = rejected.reason; continue; } // dropped for the per-minute limit / credit: a later try can work
    item.status = 'error';
    item.error = rejected.reason || 'Rejected by Easyparser.';
  }
  // Items Easyparser did not take (and did not refuse for good) stay pending without a queryId; the next run sends them again.
  // After MAX_SUBMIT_ATTEMPTS they end as errors, so a job never hangs on them.
  const waiting = toSubmit.filter((i) => i.status === 'pending' && !i.queryId);
  if (waiting.length) {
    job.submitAttempts += 1;
    job.lastError = waitingReason || 'Easyparser did not take ' + waiting.length + ' product' + (waiting.length === 1 ? '' : 's') + ' yet; sending them again.';
    if (job.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
      for (const item of waiting) { item.status = 'error'; item.error = waitingReason || 'Easyparser did not take this product.'; }
    }
  }
  job.status = 'polling';
}

/** True when some item was never accepted by Easyparser (no query id yet) and is still waiting to be sent. */
const hasUnsentItems = (job) => job.items.some((i) => i.status === 'pending' && !i.queryId);

/** Polls up to POLL_BATCH_SIZE outstanding items of one job. */
async function pollItems(job, saveProductAsDraft) {
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
      // success
      const product = normalizeDetail(result.raw, item.amazonUrl);
      item.product = product;
      if (product.asin) setCachedProduct(product.asin, item.country, product, 'easyparser').catch(() => {});
      await trySave(job, item, saveProductAsDraft);
    }));
  }
}

/** Attempts to save an item's already-fetched product as a draft, charging a credit. */
async function trySave(job, item, saveProductAsDraft) {
  if (!(await hasCredits(job.userId, ACTION_COSTS.AMAZON_IMPORT))) {
    item.status = 'fetched';
    item.outOfCredits = true;
    return;
  }
  try {
    const saved = await saveProductAsDraft(job.userId, item.product, job.markupPercent, item.amazonUrl, FAKE_REQ);
    item.status = 'done';
    item.draftId = saved.draft?.id || null;
    item.outOfCredits = false;
  } catch (err) {
    if (err.outOfCredits) { item.status = 'fetched'; item.outOfCredits = true; return; } // the credit could not be taken: wait, nothing was saved
    item.status = 'error';
    item.error = err.message || 'Could not save this product as a draft.';
  }
}

/** Re-attempts saving items that were fetched but skipped earlier for lack of credits. */
async function retrySavesForCredits(job, saveProductAsDraft) {
  const waiting = job.items.filter((i) => i.status === 'fetched');
  for (const item of waiting.slice(0, POLL_BATCH_SIZE)) {
    await trySave(job, item, saveProductAsDraft);
  }
}

async function processOneJob(job, saveProductAsDraft) {
  if (job.status === 'queued' || (job.status === 'polling' && hasUnsentItems(job))) await submitPendingItems(job);
  if (job.status === 'polling') {
    await pollItems(job, saveProductAsDraft);
    await retrySavesForCredits(job, saveProductAsDraft);
  }
  recount(job);
  const unresolved = job.items.some((i) => i.status === 'pending' || i.status === 'fetched');
  if (job.status === 'polling' && !unresolved) {
    job.status = 'done';
    job.finishedAt = new Date();
  }
  await job.save();
}

async function runBulkImportProcessor() {
  // saveProductAsDraft lives on routes/fetchProduct.js - required lazily to dodge any
  // circular-require ordering issues between routes and jobs at startup.
  const { saveProductAsDraft } = require('../routes/fetchProduct');
  const jobs = await BulkImportJob.find({ status: { $in: ['queued', 'polling'] } }).limit(10);
  for (const job of jobs) {
    try {
      await processOneJob(job, saveProductAsDraft);
    } catch (err) {
      console.error('[bulk-import] job ' + job._id + ' failed:', err.message);
    }
  }
}

function startBulkImportProcessor() {
  cron.schedule('* * * * *', async () => {
    const gotLock = await acquireLock('bulk-import-processor', 55 * 1000).catch(() => false);
    if (!gotLock) return;
    runBulkImportProcessor().catch((err) => console.error('[bulk-import] Unexpected error:', err.message));
  });
  console.log('[bulk-import] Background bulk import processor scheduled (every minute).');
}

module.exports = { startBulkImportProcessor, runBulkImportProcessor, processOneJob };
