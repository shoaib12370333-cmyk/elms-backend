// Imports without an eBay store (admin switch), what an extension import costs (0 = free, shown as such), the extension's own bulk price,
// and the admin setting itself. The routes, services and settings model are the real ones; the database is in memory.
const assert = require('assert');
const path = require('path');
process.env.EASYPARSER_API_KEY = 'test-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- settings (one document, like the real collection)
const settingsDoc = { key: 'global' };
stub('models/schemas/Settings', {
  findOne: () => { const p = Promise.resolve({ toObject: () => ({ ...settingsDoc }) }); p.lean = async () => ({ ...settingsDoc }); return p; },
  create: async () => ({ toObject: () => ({ ...settingsDoc }) }),
  findOneAndUpdate: async (q, update) => { Object.assign(settingsDoc, update); return { toObject: () => ({ ...settingsDoc }) }; },
});

// ---- the rest of the world
const db = { balance: 50, spent: [], drafts: [], jobs: [], accounts: [], seq: 0 };
stub('models/usersModel', {
  getPricingRule: async () => null, // these sellers have no pricing rule: imports are priced by markup % as before
  hasCredits: async (id, n) => db.balance >= n,
  spendCredit: async (id, n) => { if (db.balance < n) return false; db.balance -= n; db.spent.push(n); return true; },
  refundCredit: async (id, n) => { db.balance += n; },
  getUserById: async (id) => ({ id, role: 'user', creditBalance: db.balance }),
});
stub('models/ebayAccountsModel', {
  listEbayAccounts: async () => db.accounts,
  getActiveEbayAccount: async () => db.accounts.find((a) => a.isActive) || db.accounts[0] || null,
  getEbayAccountById: async (userId, id) => db.accounts.find((a) => a.id === id) || null,
});
stub('models/listingsModel', {
  listListingsBySkus: async () => [], listListingsBySku: async () => [],
  findListingInStore: async () => null,
  upsertDraft: async (userId, fields) => { db.drafts.push(fields); return { id: 'D' + db.drafts.length, status: 'draft' }; },
});
stub('models/importsModel', { createImport: async () => ({ id: 'IMP' + (++db.seq) }), updateImportImages: async () => {} });
stub('services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls });
stub('services/productCacheService', { getCachedProduct: async () => null, setCachedProduct: async () => {} });
const realCanopy = require('../services/canopyAmazonService');
stub('services/canopyAmazonService', { ...realCanopy, fetchProductByUrl: async (url) => ({ asin: realCanopy.extractAsinFromUrl(url), title: 'Widget', price: 8, currency: 'GBP', images: [], bulletPoints: [], specifications: [], sourceUrl: url }) });
stub('models/bulkImportJobsModel', { activeJobStats: async () => ({ jobs: 0, pendingItems: 0 }), createBulkImportJob: async (userId, job) => { db.jobs.push(job); return { id: 'J1', total: job.items.length }; } });
stub('services/veroSettingsService', { getVeroWordsOf: async () => [] });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });

const { ACTION_COSTS, ACTION_COST_METADATA } = require('../config/actionCosts');
const settingsModel = require('../models/settingsModel');
const extension = require('../services/extensionService');
const browserImportRoutes = require('../routes/browserImport');
const fetchRoutes = require('../routes/fetchProduct');
const extensionRoutes = require('../routes/extension');
const adminRoutes = require('../routes/admin');
const { processOneJob } = require('../jobs/bulkImportProcessor');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, method, p, req) => { const res = fakeRes(); await handler(router, method, p)({ userId: 'u1', body: {}, headers: {}, protocol: 'https', get: () => 'x', ...req }, res); return res; };
const reset = () => { db.balance = 50; db.spent = []; db.drafts = []; db.jobs = []; db.accounts = []; delete settingsDoc.importWithoutEbayAccount; };
const UK = { id: 'a'.repeat(24), label: 'Trendy UK', marketplaceId: 'EBAY_GB', isActive: true };
const url = (asin) => 'https://www.amazon.co.uk/dp/' + asin;
const product = { asin: 'B0IMPORT01', title: 'A good thing', price: 9.5, images: [] };
const importOnce = (extra = {}) => call(browserImportRoutes, 'post', '/', { body: { amazonUrl: url('B0IMPORT01'), product, markupPercent: 30, ...extra } });

(async () => {
  const oldCosts = { single: ACTION_COSTS.BROWSER_IMPORT_SCRAPE, bulkExt: ACTION_COSTS.EXTENSION_BULK_IMPORT, amazon: ACTION_COSTS.AMAZON_IMPORT };

  // ---------- the admin setting: on by default, saved, validated ----------
  reset();
  assert.strictEqual((await settingsModel.getSettings()).importWithoutEbayAccount, true, 'a fresh install allows imports without a store');
  assert.strictEqual(await extension.importWithoutStoreAllowed(), true);
  let res = await call(adminRoutes, 'put', '/settings/import-policy', { body: { importWithoutEbayAccount: false } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.settings.importWithoutEbayAccount, false);
  assert.strictEqual(await extension.importWithoutStoreAllowed(), false);
  for (const bad of [undefined, 'false', 0, null]) {
    res = await call(adminRoutes, 'put', '/settings/import-policy', { body: { importWithoutEbayAccount: bad } });
    assert.strictEqual(res.statusCode, 400, 'only true / false are accepted: ' + String(bad));
  }
  assert.strictEqual((await settingsModel.getSettings()).importWithoutEbayAccount, false, 'a refused save changed nothing');
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: true });
  assert.strictEqual(await extension.importWithoutStoreAllowed(), true);

  // ---------- extension import with no eBay store ----------
  reset();
  res = await importOnce();
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.store, null, 'saved without a store');
  assert.strictEqual(db.drafts.length, 1);
  assert.strictEqual(db.drafts[0].ebayAccountId, null);
  assert.strictEqual(db.drafts[0].marketplaceId, null);
  assert.deepStrictEqual(db.spent, [ACTION_COSTS.BROWSER_IMPORT_SCRAPE]);

  // switched off: refused before anything is paid or saved, with words the extension can show
  reset();
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: false });
  res = await importOnce();
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /Connect an eBay store in ELMS first/);
  assert.match(res.body.error, /no credit was used/);
  assert.deepStrictEqual(db.spent, []);
  assert.strictEqual(db.drafts.length, 0);
  // ... but a person who HAS a store is not affected by the switch
  db.accounts = [UK];
  res = await importOnce();
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.store.id, UK.id);
  assert.strictEqual(db.drafts[0].ebayAccountId, UK.id);

  // ---------- the website's import and the bulk imports follow the same switch ----------
  reset();
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: false });
  res = await call(fetchRoutes, 'post', '/', { body: { amazonUrl: url('B0SITE0001'), markupPercent: 10 } });
  assert.strictEqual(res.statusCode, 403, 'website import');
  res = await call(fetchRoutes, 'post', '/bulk', { body: { amazonUrls: [url('B0BULK0001')] } });
  assert.strictEqual(res.statusCode, 403, 'small bulk');
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: [url('B0BULK0002')] } });
  assert.strictEqual(res.statusCode, 403, 'background bulk');
  assert.deepStrictEqual(db.spent, []);
  assert.strictEqual(db.jobs.length, 0);
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: true });
  res = await call(fetchRoutes, 'post', '/', { body: { amazonUrl: url('B0SITE0001'), markupPercent: 10 } });
  assert.strictEqual(res.statusCode, 200, 'allowed again: ' + JSON.stringify(res.body));
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: [url('B0BULK0002')] } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db.jobs[0].ebayAccountId, null, 'a job without a store');

  // ---------- what the extension is told: policy and prices (0 stays 0) ----------
  reset();
  let info = await extension.panelInfo({ userId: 'u1' });
  assert.deepStrictEqual(info.policy, { importWithoutStore: true });
  assert.strictEqual(info.credits.importCost, ACTION_COSTS.BROWSER_IMPORT_SCRAPE);
  assert.strictEqual(info.credits.bulkImportCost, ACTION_COSTS.EXTENSION_BULK_IMPORT, 'the extension shows its own bulk price');
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: false });
  assert.deepStrictEqual((await extension.panelInfo({ userId: 'u1' })).policy, { importWithoutStore: false });
  await settingsModel.updateImportPolicy({ importWithoutEbayAccount: true });
  ACTION_COSTS.BROWSER_IMPORT_SCRAPE = 0;
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 0;
  info = await extension.panelInfo({ userId: 'u1' });
  assert.strictEqual(info.credits.importCost, 0);
  assert.strictEqual(info.credits.bulkImportCost, 0);
  res = await call(extensionRoutes, 'post', '/check', { body: { asin: 'B0IMPORT01', amazonUrl: url('B0IMPORT01') } });
  assert.strictEqual(res.body.credits.importCost, 0);
  assert.strictEqual(res.body.policy.importWithoutStore, true);

  // a free extension import works with an empty balance and spends nothing
  reset();
  ACTION_COSTS.BROWSER_IMPORT_SCRAPE = 0;
  db.balance = 0;
  res = await importOnce();
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(db.spent.filter((n) => n > 0), [], 'nothing charged');
  ACTION_COSTS.BROWSER_IMPORT_SCRAPE = 2;
  res = await importOnce();
  assert.strictEqual(res.statusCode, 402, 'with a price it needs the credits');
  ACTION_COSTS.BROWSER_IMPORT_SCRAPE = oldCosts.single;

  // ---------- the extension's bulk import has its own price; the website's bulk keeps the Amazon import price ----------
  reset();
  db.accounts = [UK];
  ACTION_COSTS.AMAZON_IMPORT = 1;
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 3;
  const two = [url('B0TWO00001'), url('B0TWO00002')];
  db.balance = 5;
  res = await call(fetchRoutes, 'post', '/bulk', { body: { amazonUrls: two, source: 'extension' } });
  assert.strictEqual(res.statusCode, 402, 'two products at 3 need 6 credits');
  assert.match(res.body.error, /needs 6 credits/);
  db.balance = 50;
  res = await call(fetchRoutes, 'post', '/bulk', { body: { amazonUrls: two, source: 'extension' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.spent, [3, 3]);
  reset(); db.accounts = [UK];
  res = await call(fetchRoutes, 'post', '/bulk', { body: { amazonUrls: two } });
  assert.deepStrictEqual(db.spent, [1, 1], 'the website\'s bulk import is priced as before');
  // free from the extension: nothing to pay, nothing needed
  reset(); db.accounts = [UK]; db.balance = 0;
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 0;
  res = await call(fetchRoutes, 'post', '/bulk', { body: { amazonUrls: two, source: 'extension' } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.results.every((r) => r.success), JSON.stringify(res.body.results));
  assert.deepStrictEqual(db.spent.filter((n) => n > 0), []);

  // the background job remembers where it came from and is paid at that price
  reset(); db.accounts = [UK];
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 3;
  db.balance = 5;
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: two, source: 'extension' } });
  assert.strictEqual(res.statusCode, 402);
  assert.match(res.body.error, /needs 6 credits/);
  db.balance = 50;
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: two, source: 'extension' } });
  assert.strictEqual(db.jobs.at(-1).source, 'extension');
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: two } });
  assert.strictEqual(db.jobs.at(-1).source, 'website');
  res = await call(fetchRoutes, 'post', '/bulk-job', { body: { amazonUrls: two, source: 'something-else' } });
  assert.strictEqual(db.jobs.at(-1).source, 'website', 'only "extension" is special');

  // the processor saves each product of an extension job at the extension price (and a free one with an empty balance)
  const runJob = async (source, balance) => {
    reset(); db.balance = balance;
    const saved = [];
    const job = { userId: 'u1', source, status: 'polling', markupPercent: 10, createdAt: new Date(), items: [{ status: 'fetched', amazonUrl: url('B0PROC0001'), asin: 'B0PROC0001', country: 'GB', product: { asin: 'B0PROC0001', title: 't', price: 5 } }], save: async () => {} };
    await processOneJob(job, async (userId, prod, markup, src, req, store, opts) => { saved.push(opts); return { draft: { id: 'D1' } }; });
    return { saved, item: job.items[0] };
  };
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 3; ACTION_COSTS.AMAZON_IMPORT = 1;
  let out = await runJob('extension', 10);
  assert.deepStrictEqual(out.saved, [{ cost: 3 }]);
  out = await runJob('website', 10);
  assert.deepStrictEqual(out.saved, [{ cost: 1 }]);
  out = await runJob('extension', 2);
  assert.strictEqual(out.saved.length, 0, '2 credits do not cover a product of 3');
  assert.strictEqual(out.item.status, 'fetched');
  ACTION_COSTS.EXTENSION_BULK_IMPORT = 0;
  out = await runJob('extension', 0);
  assert.deepStrictEqual(out.saved, [{ cost: 0 }], 'free: saved with no credits at all');
  assert.strictEqual(out.item.status, 'done');

  // ---------- the admin panel lists both extension prices, with words an admin understands ----------
  const rows = Object.fromEntries(ACTION_COST_METADATA.map((m) => [m.key, m]));
  assert.ok(/Extension: import one product/.test(rows.BROWSER_IMPORT_SCRAPE.label));
  assert.ok(/Extension: bulk import/.test(rows.EXTENSION_BULK_IMPORT.label));
  assert.ok(typeof ACTION_COSTS.EXTENSION_BULK_IMPORT === 'number');

  Object.assign(ACTION_COSTS, { BROWSER_IMPORT_SCRAPE: oldCosts.single, EXTENSION_BULK_IMPORT: oldCosts.bulkExt, AMAZON_IMPORT: oldCosts.amazon });
  console.log('import policy tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
