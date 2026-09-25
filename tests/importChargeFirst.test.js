// An import pays BEFORE it asks Amazon. The lookup costs real money: with the lookup first, a person with ONE credit could start many
// requests at once and every one of them asked Amazon (only one of them could then pay). Now the credit is taken first, atomically.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const balance = { u1: 1 };
const log = { spent: 0, refunded: 0 };
stub('models/usersModel', {
  getPricingRule: async () => null, // these sellers have no pricing rule: imports are priced by markup % as before
  hasCredits: async (id, n = 1) => (balance[id] || 0) >= n,
  spendCredit: async (id, n = 1) => {
    await new Promise((r) => setImmediate(r)); // a real database call takes time; other requests run meanwhile
    if ((balance[id] || 0) < n) return false;
    balance[id] -= n; log.spent += 1; return true;
  },
  refundCredit: async (id, n = 1) => { balance[id] += n; log.refunded += 1; return true; },
});
const canopy = require('../services/canopyAmazonService');
const lookups = [];
canopy.fetchProductByUrl = async (url) => { lookups.push(url); return { asin: canopy.extractAsinFromUrl(url), title: 'Lamp', price: 5, currency: 'USD', images: [], bulletPoints: [], specifications: [] }; };
let existing = null;
let failSave = false;
const cache = new Map();
stub('models/importsModel', { createImport: async () => ({ id: 'imp' }), updateImportImages: async () => null });
stub('models/listingsModel', { findListingInStore: async () => existing, upsertDraft: async () => { if (failSave) throw new Error('save failed'); return { id: 'draft' }; } });
stub('models/ebayAccountsModel', { getActiveEbayAccount: async () => null });
stub('services/imageStorageService', { materializeImageUrls: async () => [] });
stub('services/productCacheService', { getCachedProduct: async (asin) => cache.get(asin) || null, setCachedProduct: async (asin, country, product) => { cache.set(asin, product); } });
stub('models/settingsModel', { getLimits: async () => ({ bulkImportMax: 25, bulkJobMax: 1000 }) });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
const fetchRoutes = require('../routes/fetchProduct');

const handler = (method, p) => { const l = fetchRoutes.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const post = async (userId, url) => { const res = fakeRes(); await handler('post', '/')({ userId, body: { amazonUrl: url } }, res); return res; };
const url = (n) => 'https://www.amazon.com/dp/B0PARALL' + String(n).padStart(2, '0');
const reset = (credits) => { balance.u1 = credits; log.spent = 0; log.refunded = 0; lookups.length = 0; existing = null; failSave = false; cache.clear(); };

(async () => {
  // ---- one credit, ten requests for ten different products at the same moment: one is served, ONE Amazon lookup was made
  reset(1);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post('u1', url(i))));
  assert.strictEqual(results.filter((r) => r.body.success).length, 1, 'only one is served');
  assert.strictEqual(results.filter((r) => r.statusCode === 402).length, 9);
  assert.strictEqual(lookups.length, 1, 'and Amazon was asked once (it used to be asked ten times)');
  assert.strictEqual(balance.u1, 0);

  // ---- no credit: nothing is fetched
  reset(0);
  await assert.rejects(() => fetchRoutes.fetchAndSaveDraft('u1', url(1), 0, {}), (e) => e.outOfCredits && e.statusCode === 402);
  assert.strictEqual(lookups.length, 0, 'no credit, no Amazon call');

  // ---- the save fails after the lookup: the credit comes back (the lookup itself cannot be undone)
  reset(2); failSave = true;
  await assert.rejects(() => fetchRoutes.fetchAndSaveDraft('u1', url(2), 0, {}), /save failed/);
  assert.strictEqual(balance.u1, 2, 'a failed import costs nothing');
  assert.strictEqual(log.refunded, 1);

  // ---- a product that is already live is refused from the link alone: no credit taken, no Amazon call
  reset(2); existing = { id: 'l1', status: 'published' };
  await assert.rejects(() => fetchRoutes.fetchAndSaveDraft('u1', url(3), 0, {}), (e) => e.statusCode === 409 && e.alreadyListed);
  assert.deepStrictEqual([log.spent, lookups.length, balance.u1], [0, 0, 2]);

  // ---- a product that was fetched lately is served from the cache, and still costs its credit (as before)
  reset(2);
  await fetchRoutes.fetchAndSaveDraft('u1', url(4), 0, {});
  assert.deepStrictEqual([lookups.length, balance.u1], [1, 1]);
  await fetchRoutes.fetchAndSaveDraft('u1', url(4), 0, {});
  assert.deepStrictEqual([lookups.length, balance.u1], [1, 0], 'no second Amazon call, but the credit was taken');

  // ---- an import that is paid only once: the credit is not taken again inside the save
  assert.strictEqual(log.spent, 2, 'one credit per import, not two');

  // ---- saving a product that was fetched elsewhere (the background bulk job) still charges by itself
  reset(1);
  await fetchRoutes.saveProductAsDraft('u1', { asin: 'B0BULKITEM', title: 't', price: 1 }, 0, 'https://www.amazon.com/dp/B0BULKITEM', {}, null);
  assert.deepStrictEqual([log.spent, balance.u1], [1, 0]);
  await assert.rejects(() => fetchRoutes.saveProductAsDraft('u1', { asin: 'B0BULKITEM', title: 't', price: 1 }, 0, 'https://www.amazon.com/dp/B0BULKITEM', {}, null), (e) => e.outOfCredits);

  console.log('import charge-first tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
