// jobs/adminCatalogProcessor.js: Admin Panel > Product Catalog's background fetch run - same submit/poll shape as
// jobs/bulkImportProcessor.js (stubbed Easyparser here), but a successful item becomes a catalog row (via the
// injected saveCatalogItem) instead of a Draft, and nobody is charged a credit. runAdminCatalogProcessor's own wiring
// (resolve a category per item, never let that failure stop the product itself from being saved) is tested at the
// bottom with stubs for settingsModel/productCatalogModel/aiCategoryService (both lazily required inside it, so
// stubbing them any time before calling it is enough - no re-require dance needed).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let submitImpl = async (itemsByDomain) => ({ accepted: itemsByDomain.flatMap((d) => d.asins.map((asin) => ({ asin, domain: d.domain, queryId: 'Q-' + asin }))), rejected: [] });
let pollImpl = async (queryId) => ({ status: 'success', raw: { asin: queryId.slice(2) } });
stub('services/easyparserAmazonService', {
  toEasyparserDomain: (c) => ({ US: '.com', GB: '.co.uk' }[c] || '.com'),
  submitBulkDetail: async (itemsByDomain) => submitImpl(itemsByDomain),
  pollResult: async (queryId) => pollImpl(queryId),
  normalizeDetail: (raw, sourceUrl) => ({ asin: raw.asin, title: 'Product ' + raw.asin, description: '', bulletPoints: [], images: [], price: 9.99, currency: 'USD', specifications: [], sourceUrl }),
});
stub('services/productCacheService', { setCachedProduct: async () => {} });
stub('services/jobLockService', { withLease: async (name, ms, fn) => fn({ renew: async () => {} }) });

// A minimal stand-in for the Mongoose model: a job built with `new` behaves like a document whose .save() is a no-op;
// find/findById/updateOne default to harmless answers and are overridden per test section where it matters.
function AdminCatalogJobFake(data) { Object.assign(this, data); }
AdminCatalogJobFake.prototype.save = async function () {};
AdminCatalogJobFake.find = () => ({ sort: () => ({ limit: async () => [] }) });
AdminCatalogJobFake.findById = () => ({ select: () => ({ lean: async () => null }) });
AdminCatalogJobFake.updateOne = async () => {};
stub('models/schemas/AdminCatalogJob', AdminCatalogJobFake);

const AdminCatalogJob = require('../models/schemas/AdminCatalogJob');
const { processOneJob } = require('../jobs/adminCatalogProcessor');

const item = (asin, over = {}) => ({ amazonUrl: 'https://www.amazon.com/dp/' + asin, asin, country: 'US', status: 'pending', ...over });
const freshJob = (items) => new AdminCatalogJob({ createdBy: '000000000000000000000001', marketplaceId: 'EBAY_US', status: 'queued', items, total: items.length, done: 0, failed: 0, submitAttempts: 0 });

(async () => {
  // ---------- a queued job: items are submitted, accepted ones are polled, resolved and saved in the same run ----------
  let job = freshJob([item('B0ADMIN001'), item('B0ADMIN002')]);
  const saved = [];
  const saveCatalogItem = async (j, it, product) => { saved.push({ asin: it.asin, title: product.title }); return { id: 'CAT-' + it.asin }; };
  await processOneJob(job, saveCatalogItem);
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.done, 2);
  assert.strictEqual(job.failed, 0);
  assert.deepStrictEqual(job.items.map((i) => i.status), ['done', 'done']);
  assert.deepStrictEqual(job.items.map((i) => i.catalogItemId), ['CAT-B0ADMIN001', 'CAT-B0ADMIN002']);
  assert.deepStrictEqual(saved.map((s) => s.asin).sort(), ['B0ADMIN001', 'B0ADMIN002']);

  // ---------- Easyparser rejects an ASIN outright (not retryable) - it errors without ever being polled ----------
  job = freshJob([item('B0BAD00001')]);
  submitImpl = async () => ({ accepted: [], rejected: [{ asin: 'B0BAD00001', domain: '.com', reason: 'Not a real product page.', retryable: false }] });
  await processOneJob(job, async () => ({ id: 'should-not-be-called' }));
  assert.strictEqual(job.items[0].status, 'error');
  assert.match(job.items[0].error, /Not a real product/);
  assert.strictEqual(job.status, 'done');
  submitImpl = async (itemsByDomain) => ({ accepted: itemsByDomain.flatMap((d) => d.asins.map((asin) => ({ asin, domain: d.domain, queryId: 'Q-' + asin }))), rejected: [] });

  // ---------- Easyparser accepts it, but the fetch itself later fails ----------
  job = freshJob([item('B0FAIL0001')]);
  pollImpl = async () => ({ status: 'failure', error: 'Amazon blocked the request.' });
  await processOneJob(job, async () => ({ id: 'should-not-be-called' }));
  assert.strictEqual(job.items[0].status, 'error');
  assert.match(job.items[0].error, /Amazon blocked/);
  pollImpl = async (queryId) => ({ status: 'success', raw: { asin: queryId.slice(2) } });

  // ---------- still pending at Easyparser: the job stays polling, nothing is saved yet ----------
  job = freshJob([item('B0WAIT0001')]);
  pollImpl = async () => ({ status: 'pending' });
  await processOneJob(job, async () => { throw new Error('must not be called while still pending'); });
  assert.strictEqual(job.items[0].status, 'pending');
  assert.strictEqual(job.status, 'polling');
  pollImpl = async (queryId) => ({ status: 'success', raw: { asin: queryId.slice(2) } });

  // ---------- saving to the catalog itself fails (e.g. a database hiccup): the item errors, the job is not stuck ----------
  job = freshJob([item('B0ERR00001')]);
  await processOneJob(job, async () => { throw new Error('disk full'); });
  assert.strictEqual(job.items[0].status, 'error');
  assert.match(job.items[0].error, /disk full/);
  assert.strictEqual(job.status, 'done');

  // ---------- cancelled mid-run: the status this run computed is overridden back to cancelled ----------
  job = freshJob([item('B0CANCEL01')]);
  await processOneJob(job, async () => ({ id: 'x' }), { isCancelled: async () => true });
  assert.strictEqual(job.status, 'cancelled');

  console.log('admin catalog processor tests passed');
  await runWiringTests();
})().catch((e) => { console.error(e); process.exit(1); });

/** runAdminCatalogProcessor's own wiring: category resolution is charged to the admin who started the job, and a
 * category failure never stops the product itself from being saved to the catalog. */
async function runWiringTests() {
  const categoryCalls = [];
  let categoryBehavior = async () => ({ id: '9355', name: 'Gadgets' });
  stub('services/aiCategoryService', { pickCategory: async (userId, title, marketplaceId) => { categoryCalls.push({ userId, title, marketplaceId }); return categoryBehavior(); } });
  stub('models/settingsModel', { getLimits: async () => ({ catalogRetentionDays: 14 }) });
  const createCalls = [];
  stub('models/productCatalogModel', { createCatalogItem: async (args) => { createCalls.push(args); return { id: 'CAT-' + args.product.asin }; } });

  const { runAdminCatalogProcessor } = require('../jobs/adminCatalogProcessor');

  AdminCatalogJobFake.find = () => ({ sort: () => ({ limit: async () => [freshJob([item('B0WIRE0001')])] }) });
  await runAdminCatalogProcessor({});
  assert.strictEqual(categoryCalls.length, 1);
  assert.strictEqual(categoryCalls[0].userId, '000000000000000000000001', 'charged to the admin who started the fetch');
  assert.strictEqual(categoryCalls[0].marketplaceId, 'EBAY_US');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].categoryId, '9355');
  assert.strictEqual(createCalls[0].categoryError, null);
  const expectedExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(createCalls[0].expiresAt.getTime() - expectedExpiry) < 5000, 'expiresAt is ~14 days out, from the global setting');

  // category resolution fails (no category list, AI off, no credits ...): the product is still saved, uncategorized
  categoryBehavior = async () => { throw new Error('No category list is uploaded for this marketplace.'); };
  createCalls.length = 0;
  AdminCatalogJobFake.find = () => ({ sort: () => ({ limit: async () => [freshJob([item('B0WIRE0002')])] }) });
  await runAdminCatalogProcessor({});
  assert.strictEqual(createCalls.length, 1, 'the row is still saved even though category resolution failed');
  assert.strictEqual(createCalls[0].categoryId, null);
  assert.match(createCalls[0].categoryError, /No category list/);

  console.log('admin catalog processor wiring tests passed');
}
