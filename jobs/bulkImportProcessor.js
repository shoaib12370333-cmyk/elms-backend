const cron = require('node-cron');
const BulkImportJob = require('../models/schemas/BulkImportJob');
const { withLease } = require('../services/jobLockService');
const { hasCredits } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { toEasyparserDomain, submitBulkDetail, pollResult, normalizeDetail } = require('../services/easyparserAmazonService');
const { setCachedProduct } = require('../services/productCacheService');

const MAX_SUBMIT_ATTEMPTS = 5;
const ITEM_TIMEOUT_MS = 30 * 60 * 1000; // give up on a single item after 30 minutes of polling
const POLL_BATCH_SIZE = 100; // items polled per tick (job runs once a minute - see startBulkImportProcessor)
const POLL_CONCURRENCY = 10;
const GIVE_UP_ON_CREDITS_MS = 24 * 60 * 60 * 1000; // products that could not be saved for lack of credits are not waited for longer than this

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
async function pollItems(job, saveProductAsDraft, hooks = {}) {
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
      await trySave(job, item, saveProductAsDraft, hooks);
    }));
    if (hooks.renew) await hooks.renew(); // still working: keep the lease
  }
}

/** Attempts to save an item's already-fetched product as a draft, charging a credit. */
async function trySave(job, item, saveProductAsDraft, hooks = {}) {
  if (!(await hasCredits(job.userId, ACTION_COSTS.AMAZON_IMPORT))) {
    item.status = 'fetched';
    item.outOfCredits = true;
    return;
  }
  try {
    // Into the store the job was made for (not whichever store happens to be active when the item is saved).
    let store;
    if (job.ebayAccountId) {
      store = await require('../models/ebayAccountsModel').getEbayAccountById(job.userId, String(job.ebayAccountId));
      if (!store) throw new Error('The eBay store of this import is no longer connected.');
    }
    const saved = await saveProductAsDraft(job.userId, item.product, job.markupPercent, item.amazonUrl, FAKE_REQ, store);
    item.status = 'done';
    item.draftId = saved.draft?.id || null;
    item.outOfCredits = false;
    item.product = null; // the draft has it now; keeping every product made a job of ~1000 items bigger than MongoDB's 16 MB document limit
    // Written straight to the database: a restart (or a failed save of the whole job) must not make this item be charged again.
    if (hooks.persistItem) await hooks.persistItem(job, item);
  } catch (err) {
    if (err.outOfCredits) { item.status = 'fetched'; item.outOfCredits = true; return; } // the credit could not be taken: wait, nothing was saved
    item.status = 'error';
    item.error = err.message || 'Could not save this product as a draft.';
  }
}

/** Re-attempts saving items that were fetched but skipped earlier for lack of credits. */
async function retrySavesForCredits(job, saveProductAsDraft, hooks = {}) {
  const waiting = job.items.filter((i) => i.status === 'fetched');
  for (const item of waiting.slice(0, POLL_BATCH_SIZE)) {
    await trySave(job, item, saveProductAsDraft, hooks);
    if (hooks.renew) await hooks.renew();
  }
}

/**
 * Products that were fetched but could not be saved for lack of credits are not waited for for ever (a job that never ends stays in
 * the processor's list): after a day they become errors that say so. The Retry button saves them once credits are added - they are
 * already fetched, so nothing is fetched again.
 */
function giveUpOnUnaffordableItems(job, now = Date.now()) {
  if (!job.createdAt || now - new Date(job.createdAt).getTime() < GIVE_UP_ON_CREDITS_MS) return;
  for (const item of job.items) {
    if (item.status !== 'fetched') continue;
    item.status = 'error';
    item.outOfCredits = true;
    item.error = 'Not saved: there were not enough credits for a day. Add credits and press Retry to save it (it is already fetched).';
  }
}

async function processOneJob(job, saveProductAsDraft, hooks = {}) {
  if (job.status === 'queued' || (job.status === 'polling' && hasUnsentItems(job))) await submitPendingItems(job);
  if (job.status === 'polling') {
    await pollItems(job, saveProductAsDraft, hooks);
    await retrySavesForCredits(job, saveProductAsDraft, hooks);
    giveUpOnUnaffordableItems(job);
  }
  recount(job);
  const unresolved = job.items.some((i) => i.status === 'pending' || i.status === 'fetched');
  if (job.status === 'polling' && !unresolved) {
    job.status = 'done';
    job.finishedAt = new Date();
  }
  job.lastProcessedAt = new Date();
  // The person may have pressed Cancel while this run was busy with the job: saving it as it was read would bring it back to life.
  if (hooks.isCancelled && await hooks.isCancelled(job)) job.status = 'cancelled';
  await job.save();
}

/** True when the job was cancelled in the database after this run read it. */
async function isCancelled(job) {
  const row = await BulkImportJob.findById(job._id).select('status').lean();
  return !!row && row.status === 'cancelled';
}

/** Writes one saved item straight to the database (see trySave). Never throws: the whole job is saved at the end of the run anyway. */
async function persistItem(job, item) {
  try {
    await BulkImportJob.updateOne(
      { _id: job._id, items: { $elemMatch: { asin: item.asin, country: item.country } } },
      { $set: { 'items.$.status': 'done', 'items.$.draftId': item.draftId, 'items.$.outOfCredits': false, 'items.$.product': null } }
    );
  } catch (err) {
    console.warn('[bulk-import] could not write the progress of ' + item.asin + ': ' + err.message);
  }
}

async function runBulkImportProcessor({ renew } = {}) {
  // saveProductAsDraft lives on routes/fetchProduct.js - required lazily to dodge any
  // circular-require ordering issues between routes and jobs at startup.
  const { saveProductAsDraft } = require('../routes/fetchProduct');
  // The job that was worked on longest ago first (new ones have never been), so a job that cannot move (no credits) does not hold up
  // the others: it goes to the back of the line every time it has had its turn.
  const jobs = await BulkImportJob.find({ status: { $in: ['queued', 'polling'] } }).sort({ lastProcessedAt: 1 }).limit(10);
  for (const job of jobs) {
    try {
      await processOneJob(job, saveProductAsDraft, { persistItem, isCancelled, renew });
    } catch (err) {
      console.error('[bulk-import] job ' + job._id + ' failed:', err.message);
    }
    if (renew) await renew(); // still working: keep the lease
  }
}

function startBulkImportProcessor() {
  cron.schedule('* * * * *', async () => {
    // Held until the run is over. A run over many products takes longer than a minute, and a second run beside it would fetch,
    // save and CHARGE the same items again.
    try { await withLease('bulk-import-processor', 10 * 60 * 1000, ({ renew }) => runBulkImportProcessor({ renew })); }
    catch (err) { console.error('[bulk-import] Unexpected error:', err.message); }
  });
  console.log('[bulk-import] Background bulk import processor scheduled (every minute).');
}

module.exports = { startBulkImportProcessor, runBulkImportProcessor, processOneJob };
