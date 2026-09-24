// Bulk import from the extension (search / bestseller pages): what the user already has for a list of ASINs, the store the
// products go to, and no credit spent on a product that cannot be imported (live, paused, scheduled ...).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.EASYPARSER_API_KEY = 'test-key';

const U1 = '1'.repeat(24);
const UK = 'a'.repeat(24);
const US = 'b'.repeat(24);
const FOREIGN = 'c'.repeat(24);
const accounts = [
  { id: UK, label: 'Trendy UK', marketplaceId: 'EBAY_GB', isActive: true },
  { id: US, label: 'US shop', marketplaceId: 'EBAY_US', isActive: false },
];
const db = { listings: [], spent: [], drafts: [], jobs: [], balance: 50, seq: 0 };
const row = (sku, status, storeId, extra = {}) => ({ id: 'L' + (++db.seq), sku, status, ebay_account_id: storeId, ...extra });

stub('models/usersModel', {
  hasCredits: async (id, n) => db.balance >= n,
  spendCredit: async (id, n) => { if (db.balance < n) return false; db.balance -= n; db.spent.push(n); return true; },
  refundCredit: async (id, n) => { db.balance += n; },
  getUserById: async (id) => ({ id, role: 'user', creditBalance: db.balance }),
});
stub('models/ebayAccountsModel', {
  listEbayAccounts: async () => accounts,
  getActiveEbayAccount: async () => accounts.find((a) => a.isActive),
  getEbayAccountById: async (userId, id) => accounts.find((a) => a.id === id) || null,
});
stub('models/listingsModel', {
  listListingsBySkus: async (userId, skus) => db.listings.filter((l) => skus.includes(l.sku)),
  listListingsBySku: async (userId, sku) => db.listings.filter((l) => l.sku === sku),
  findListingInStore: async (userId, sku, storeId) => db.listings.find((l) => l.sku === sku && (l.ebay_account_id === storeId || l.ebay_account_id === null)) || null,
  upsertDraft: async (userId, fields) => { db.drafts.push(fields); return { id: 'D' + db.drafts.length, status: 'draft' }; },
});
stub('models/importsModel', { createImport: async () => ({ id: 'IMP' }), updateImportImages: async () => {} });
stub('services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls });
stub('services/productCacheService', { getCachedProduct: async () => null, setCachedProduct: async () => {} });
const realCanopy = require('../services/canopyAmazonService');
stub('services/canopyAmazonService', { ...realCanopy, fetchProductByUrl: async (url) => ({ asin: realCanopy.extractAsinFromUrl(url), title: 'Widget ' + url.slice(-10), price: 8, currency: 'GBP', images: [], bulletPoints: [], specifications: [], sourceUrl: url }) });
stub('models/settingsModel', { getLimits: async () => ({ bulkImportMax: 25, bulkJobMax: 1000 }) });
stub('models/bulkImportJobsModel', { createBulkImportJob: async (userId, job) => { db.jobs.push(job); return { id: 'J1', total: job.items.length }; } });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const extension = require('../services/extensionService');
const extensionRoutes = require('../routes/extension');
const fetchRoutes = require('../routes/fetchProduct');
const { processOneJob } = require('../jobs/bulkImportProcessor');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, p, req) => { const res = fakeRes(); await handler(router, 'post', p)({ userId: U1, body: {}, headers: {}, protocol: 'https', get: () => 'x', ...req }, res); return res; };
const reset = () => { db.listings = []; db.spent = []; db.drafts = []; db.jobs = []; db.balance = 50; };
const url = (asin) => 'https://www.amazon.co.uk/dp/' + asin;

(async () => {
  // ---------- what the user already has, for a list of ASINs ----------
  reset();
  db.listings.push(row('B0AAAAAAA1', 'draft', UK), row('B0AAAAAAA2', 'published', US), row('B0AAAAAAA2', 'draft', UK), row('B0OTHER000', 'draft', UK));
  let known = await extension.knownFor(U1, ['b0aaaaaaa1', 'B0AAAAAAA2', 'B0AAAAAAA2', 'nope', '', null, 'B0NOTHERE1']);
  assert.deepStrictEqual(known.map((k) => [k.asin, k.status, k.storeId, k.storeLabel]), [
    ['B0AAAAAAA1', 'draft', UK, 'Trendy UK'],
    ['B0AAAAAAA2', 'published', US, 'US shop'],
    ['B0AAAAAAA2', 'draft', UK, 'Trendy UK'],
  ], 'every listing of the asked ASINs, in every store; junk and repeats ignored; other products left out');
  assert.deepStrictEqual(await extension.knownFor(U1, []), []);
  assert.deepStrictEqual(await extension.knownFor(U1, 'not a list'), []);

  let res = await call(extensionRoutes, '/known', { body: { asins: ['B0AAAAAAA1'] } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.known.length, 1);
  res = await call(extensionRoutes, '/known', { body: {} });
  assert.deepStrictEqual(res.body.known, []);

  // ---------- one by one (POST /bulk): the chosen store, and nothing charged for a product that cannot be imported ----------
  reset();
  db.listings.push(row('B0LIVE0001', 'published', UK), row('B0DRAFT001', 'draft', UK));
  res = await call(fetchRoutes, '/bulk', { body: { amazonUrls: [url('B0LIVE0001'), url('B0DRAFT001'), url('B0NEW00001')], markupPercent: 60, ebayAccountId: UK } });
  assert.strictEqual(res.statusCode, 200);
  const [live, draft, fresh] = res.body.results;
  assert.strictEqual(live.success, false);
  assert.strictEqual(live.error, 'This product is already live on eBay in Trendy UK. Nothing was imported and no credit was used.');
  assert.strictEqual(draft.success, true, 'a draft is refreshed');
  assert.strictEqual(fresh.success, true);
  assert.deepStrictEqual(db.spent, [1, 1], 'a credit for the two that were saved, none for the live one');
  assert.deepStrictEqual(db.drafts.map((d) => d.ebayAccountId), [UK, UK]);

  // the store is the user's own, else 404 and nothing is done
  reset();
  res = await call(fetchRoutes, '/bulk', { body: { amazonUrls: [url('B0NEW00001')], ebayAccountId: FOREIGN } });
  assert.strictEqual(res.statusCode, 404);
  assert.ok(/not found/.test(res.body.error));
  assert.deepStrictEqual([db.spent, db.drafts.length], [[], 0]);

  // no store chosen: the active one, as before
  reset();
  res = await call(fetchRoutes, '/bulk', { body: { amazonUrls: [url('B0NEW00001')] } });
  assert.strictEqual(db.drafts[0].ebayAccountId, UK);

  // the same product in ANOTHER store is not in the way
  reset();
  db.listings.push(row('B0NEW00001', 'published', US));
  res = await call(fetchRoutes, '/bulk', { body: { amazonUrls: [url('B0NEW00001')], ebayAccountId: UK } });
  assert.strictEqual(res.body.results[0].success, true);

  // ---------- the background job: made for a store ----------
  reset();
  res = await call(fetchRoutes, '/bulk-job', { body: { amazonUrls: [url('B0NEW00001'), url('B0NEW00002')], markupPercent: 60, ebayAccountId: US.replace(/b/g, 'a') } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.jobs[0].ebayAccountId, UK);
  reset();
  res = await call(fetchRoutes, '/bulk-job', { body: { amazonUrls: [url('B0NEW00001')], markupPercent: 60, ebayAccountId: FOREIGN } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.jobs.length, 0, 'no job for a store that is not the user\'s');

  // ---------- the processor saves each item into the job's store ----------
  const saved = [];
  const fakeSave = async (userId, product, markup, sourceUrl, req, store) => { saved.push([product.asin, store && store.id]); return { draft: { id: 'd-' + product.asin } }; };
  const jobFor = (ebayAccountId) => ({ userId: U1, ebayAccountId, markupPercent: 10, status: 'polling', total: 1, done: 0, failed: 0, submitAttempts: 0, lastError: null, finishedAt: null, save: async () => {}, items: [{ amazonUrl: url('B0NEW00001'), asin: 'B0NEW00001', country: 'GB', status: 'fetched', queryId: 'q', submittedAt: new Date(), product: { asin: 'B0NEW00001', title: 'T', price: 8, currency: 'GBP' }, draftId: null, error: null, outOfCredits: false }] });
  let job = jobFor(US);
  await processOneJob(job, fakeSave);
  assert.deepStrictEqual(saved, [['B0NEW00001', US]], 'the store of the job, not the active one');
  assert.strictEqual(job.items[0].status, 'done');

  saved.length = 0;
  job = jobFor(null);
  await processOneJob(job, fakeSave);
  assert.deepStrictEqual(saved, [['B0NEW00001', undefined]], 'a job without a store: the active store is used when saving, as before');

  saved.length = 0;
  job = jobFor(FOREIGN);
  await processOneJob(job, fakeSave);
  assert.strictEqual(job.items[0].status, 'error', 'a store that is gone: the item fails, nothing is saved');
  assert.ok(/no longer connected/.test(job.items[0].error));
  assert.deepStrictEqual(saved, []);

  console.log('extension bulk tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
