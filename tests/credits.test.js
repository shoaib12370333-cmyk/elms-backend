// Credits: every billable action pays first (atomically) and gives the credit back on failure; a list charges once per product;
// many parallel requests cannot share one credit; the daily order-sync fee and the welcome credits cannot be collected twice.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- an in-memory balance with the same guarantee as the database's atomic update ----
const balance = { u1: 1, u2: 5, admin: 0 };
const isAdmin = (id) => id === 'admin';
const log = { spent: [], refunded: [] };
let refundFails = false;
stub('models/usersModel', {
  getPricingRule: async () => null, // these sellers have no pricing rule: imports are priced by markup % as before
  hasCredits: async (id, n = 1) => n <= 0 || isAdmin(id) || (balance[id] || 0) >= n,
  spendCredit: async (id, n = 1) => {
    if (n <= 0 || isAdmin(id)) return true;
    await new Promise((r) => setImmediate(r)); // a real database call takes time; other requests run meanwhile
    if ((balance[id] || 0) < n) return false;
    balance[id] -= n; log.spent.push([id, n]); return true;
  },
  refundCredit: async (id, n = 1) => { if (refundFails) throw new Error('db down'); if (n > 0 && !isAdmin(id)) { balance[id] += n; log.refunded.push([id, n]); } return true; },
});
const { withCredits, outOfCredits } = require('../services/creditService');
const { ACTION_COSTS } = require('../config/actionCosts');

// ---- pieces the import routes need ----
const canopy = require('../services/canopyAmazonService');
const fetched = [];
canopy.fetchProductByUrl = async (url) => { fetched.push(url); const asin = canopy.extractAsinFromUrl(url); return { asin, title: 'Lamp ' + asin, price: 5, currency: 'USD', images: [], bulletPoints: [], specifications: [] }; };
stub('models/importsModel', { createImport: async () => ({ id: 'imp' }), updateImportImages: async () => null });
let failSave = false;
stub('models/listingsModel', { findListingInStore: async () => null, upsertDraft: async () => { if (failSave) throw new Error('save failed'); return { id: 'draft' }; } });
stub('models/ebayAccountsModel', { getActiveEbayAccount: async () => null });
stub('services/imageStorageService', { materializeImageUrls: async () => [] });
stub('services/productCacheService', { getCachedProduct: async () => null, setCachedProduct: async () => null });
stub('models/settingsModel', { getLimits: async () => ({ bulkImportMax: 25, bulkJobMax: 1000 }) });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
const fetchRoutes = require('../routes/fetchProduct');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, method, p, req) => { const res = fakeRes(); await handler(router, method, p)({ userId: 'u1', body: {}, query: {}, ...req }, res); return res; };

(async () => {
  // ---------- withCredits ----------
  let ran = 0;
  await assert.rejects(() => withCredits('u1', 2, async () => { ran++; }), (e) => e.statusCode === 402 && e.outOfCredits);
  assert.strictEqual(ran, 0, 'nothing runs when the credit cannot be taken');
  assert.strictEqual(balance.u1, 1);

  assert.strictEqual(await withCredits('u1', 1, async () => 'ok'), 'ok');
  assert.strictEqual(balance.u1, 0, 'charged once');
  balance.u1 = 1;

  await assert.rejects(() => withCredits('u1', 1, async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(balance.u1, 1, 'given back when the work fails');

  refundFails = true; // a failed refund must not hide the real error
  await assert.rejects(() => withCredits('u1', 1, async () => { throw new Error('boom2'); }), /boom2/);
  refundFails = false; balance.u1 = 1;

  assert.strictEqual(await withCredits('admin', 3, async () => 'free for admins'), 'free for admins');
  assert.strictEqual(await withCredits('u1', 0, async () => 'free action'), 'free action');
  assert.strictEqual(balance.u1, 1);

  // ---------- one credit, twenty requests at the same time: exactly one is served ----------
  let served = 0;
  let reviewsImpl = async () => { served++; return { reviews: [] }; };
  canopy.fetchProductReviews = (...a) => reviewsImpl(...a); // the route keeps its own reference, so it goes through this
  const research2 = require('../routes/researchTools');
  const results = await Promise.all(Array.from({ length: 20 }, () => call(research2, 'get', '/review-analyzer', { userId: 'u1', query: { asin: 'B0AAAAAAAA' } })));
  assert.strictEqual(results.filter((r) => r.body.success).length, 1, 'only one of twenty parallel requests is served');
  assert.strictEqual(results.filter((r) => r.statusCode === 402).length, 19);
  assert.strictEqual(served, 1, 'the paid Amazon call ran once');
  assert.strictEqual(balance.u1, 0, 'the one credit was used once');

  // a failing Amazon call gives the credit back
  balance.u1 = 3;
  reviewsImpl = async () => { throw Object.assign(new Error('Amazon down'), { statusCode: 502 }); };
  const failed = await call(research2, 'get', '/review-analyzer', { userId: 'u1', query: { asin: 'B0AAAAAAAA' } });
  assert.strictEqual(failed.statusCode, 502);
  assert.strictEqual(balance.u1, 3, 'nothing kept for a failed call');

  // ---------- an import: no credit, nothing saved; a failed save gives it back ----------
  balance.u1 = 0;
  await assert.rejects(() => fetchRoutes.saveProductAsDraft('u1', { asin: 'B0AAAAAAAA', title: 't', price: 1 }, null, 'https://www.amazon.com/dp/B0AAAAAAAA', {}, null), (e) => e.outOfCredits);
  balance.u1 = 2; failSave = true;
  await assert.rejects(() => fetchRoutes.saveProductAsDraft('u1', { asin: 'B0AAAAAAAA', title: 't', price: 1 }, null, 'https://www.amazon.com/dp/B0AAAAAAAA', {}, null), /save failed/);
  assert.strictEqual(balance.u1, 2, 'a failed save costs nothing');
  failSave = false;

  // ---------- a list: one credit per product, the same product twice counts once, the list must be affordable ----------
  balance.u2 = 5;
  const a = 'https://www.amazon.com/dp/B0AAAAAAAA', b = 'https://www.amazon.com/dp/B0BBBBBBBB', aAgain = 'https://www.amazon.com/Some-Title/dp/B0AAAAAAAA?ref=x';
  fetched.length = 0;
  let res = await call(fetchRoutes, 'post', '/bulk', { userId: 'u2', body: { amazonUrls: [a, b, aAgain, 'not a link'] } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.results.filter((r) => r.success).length, 2);
  assert.strictEqual(balance.u2, 3, '2 products, 2 credits (the repeat and the bad link are free)');
  assert.deepStrictEqual(fetched, [a, b], 'the repeat is not fetched');
  assert.strictEqual(res.body.results.find((r) => r.amazonUrl === aAgain).skipped, true);

  balance.u2 = 1; fetched.length = 0;
  res = await call(fetchRoutes, 'post', '/bulk', { userId: 'u2', body: { amazonUrls: [a, b] } });
  assert.strictEqual(res.statusCode, 402, 'a list that cannot be paid is refused before anything is fetched');
  assert.strictEqual(res.body.needed, 2);
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual(balance.u2, 1);

  // ---------- the background job: the admin-set cost is used, and an item that cannot be paid waits without being saved ----------
  const { processOneJob } = require('../jobs/bulkImportProcessor');
  const savedCalls = [];
  const saveFn = async (userId, product) => { savedCalls.push(product.asin); return fetchRoutes.saveProductAsDraft(userId, product, 0, 'u', {}, null); };
  const oldCost = ACTION_COSTS.AMAZON_IMPORT;
  ACTION_COSTS.AMAZON_IMPORT = 2; balance.u2 = 1;
  const job = { userId: 'u2', status: 'polling', markupPercent: 0, items: [{ status: 'fetched', product: { asin: 'B0CCCCCCCC', title: 't', price: 1 }, amazonUrl: 'u' }], save: async () => {} };
  await processOneJob(job, saveFn);
  assert.strictEqual(job.items[0].status, 'fetched', 'cost 2, balance 1: waits');
  assert.strictEqual(job.items[0].outOfCredits, true);
  assert.deepStrictEqual(savedCalls, [], 'not even attempted (and so never saved for free)');
  balance.u2 = 2;
  await processOneJob(job, saveFn);
  assert.strictEqual(job.items[0].status, 'done');
  assert.strictEqual(balance.u2, 0, 'charged the real cost');
  // the credit disappears between the check and the charge (another request took it): still not saved for free
  const racy = { userId: 'u2', status: 'polling', markupPercent: 0, items: [{ status: 'fetched', product: { asin: 'B0DDDDDDDD', title: 't', price: 1 }, amazonUrl: 'u' }], save: async () => {} };
  balance.u2 = 2;
  const realHas = require('../models/usersModel').hasCredits;
  require('../models/usersModel').hasCredits = async () => true; // the check says yes ...
  balance.u2 = 0;                                              // ... but the balance is gone when it is charged
  await processOneJob(racy, saveFn);
  assert.strictEqual(racy.items[0].status, 'fetched');
  assert.strictEqual(racy.items[0].outOfCredits, true);
  require('../models/usersModel').hasCredits = realHas;
  ACTION_COSTS.AMAZON_IMPORT = oldCost;

  // ---------- the daily order-sync fee: many syncs at once, one charge ----------
  const users = { u3: { lastOrderSyncCreditChargeAt: null, orderSyncMode: 'polling' } };
  let feeSpent = 0;
  stub('models/schemas/User', {
    findOneAndUpdate: async (filter, update, opts) => {
      await new Promise((r) => setImmediate(r));
      const u = users[filter._id];
      const last = u.lastOrderSyncCreditChargeAt;
      const startOfToday = filter.$or[1].lastOrderSyncCreditChargeAt.$lt;
      if (last && !(last < startOfToday)) return null;
      const before = { orderSyncMode: u.orderSyncMode };
      u.lastOrderSyncCreditChargeAt = update.$set.lastOrderSyncCreditChargeAt;
      return before;
    },
  });
  require('../models/usersModel').spendCredit = async (id, n) => { feeSpent += n; return true; };
  stub('services/orderSyncService', { syncAccountOrders: async () => ({}) });
  stub('models/schemas/EbayAccount', { find: async () => [] });
  stub('services/jobLockService', { acquireLock: async () => true });
  const { chargeDailyOrderSyncFeeIfDue } = require('../jobs/orderSync');
  await Promise.all(Array.from({ length: 6 }, () => chargeDailyOrderSyncFeeIfDue({ _id: 'u3', orderSyncMode: 'polling' })));
  assert.strictEqual(feeSpent, ACTION_COSTS.ORDER_SYNC_POLLING_DAILY, 'six syncs at once, one daily fee');
  await chargeDailyOrderSyncFeeIfDue({ _id: 'u3', orderSyncMode: 'polling' });
  assert.strictEqual(feeSpent, ACTION_COSTS.ORDER_SYNC_POLLING_DAILY, 'and none again the same day');

  // ---------- welcome credits: one mailbox / browser / network cannot collect them again and again ----------
  const guardPath = require.resolve('../services/signupBonusGuard');
  delete require.cache[guardPath];
  const existingKeys = new Set(['ab@gmail.com']);
  let seenDevices = new Set(['dev-real-1234']);
  let ipOwners = [];
  stub('models/schemas/User', { exists: async (f) => (existingKeys.has(f.emailKey) ? { _id: 1 } : null), find: () => ({ limit: () => ({ lean: async () => [{ _id: 'n1' }, { _id: 'n2' }, { _id: 'n3' }] }) }) });
  stub('models/schemas/LoginEvent', { exists: async (f) => (seenDevices.has(f.deviceId) ? { _id: 1 } : null), distinct: async () => ipOwners });
  const guard = require('../services/signupBonusGuard');
  assert.strictEqual(guard.emailKey('A.B+promo@Gmail.com'), 'ab@gmail.com');
  assert.strictEqual(guard.emailKey('a.b@googlemail.com'), 'ab@gmail.com');
  assert.strictEqual(guard.emailKey('john+x@example.com'), 'john@example.com');
  assert.strictEqual(guard.emailKey('j.ohn@example.com'), 'j.ohn@example.com', 'dots only count for Gmail');
  assert.strictEqual((await guard.welcomeBonusDecision('a.b+2@gmail.com', { ip: '1.1.1.1', deviceId: 'dev-new-99999' })).allowed, false, 'same mailbox written differently');
  assert.strictEqual((await guard.welcomeBonusDecision('fresh@gmail.com', { ip: '1.1.1.1', deviceId: 'dev-real-1234' })).allowed, false, 'a browser that already has an account');
  assert.strictEqual((await guard.welcomeBonusDecision('fresh@gmail.com', { ip: '1.1.1.1', deviceId: 'ua-guessed' })).allowed, true, 'a guessed browser id proves nothing');
  ipOwners = ['x', 'y'];
  assert.strictEqual((await guard.welcomeBonusDecision('fresh@gmail.com', { ip: '1.1.1.1', deviceId: 'dev-new-99999' })).allowed, true, 'a few people on one network are fine');
  ipOwners = ['x', 'y', 'z'];
  assert.strictEqual((await guard.welcomeBonusDecision('fresh@gmail.com', { ip: '1.1.1.1', deviceId: 'dev-new-99999' })).allowed, false, 'a farm of new accounts from one network is not');
  void outOfCredits;
  console.log('credits tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
