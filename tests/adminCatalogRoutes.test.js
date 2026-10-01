// routes/admin.js's Product Catalog endpoints: input parsing (bare ASIN vs full Amazon URL, dedup, the marketplace
// a bare ASIN defaults its country to), and that each route delegates to the right model function with the right
// arguments. The models underneath are stubs; validationService/canopyAmazonService/config/ebayMarketplaces are real
// (pure logic, worth exercising for real).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.EASYPARSER_API_KEY = 'test-key';
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });

const users = { 'seller@example.com': { _id: 'seller1' } };
stub('models/schemas/User', { findOne: (q) => ({ lean: async () => users[q.email] || null }) });

let createdJob = null;
stub('models/adminCatalogJobsModel', {
  createAdminCatalogJob: async (createdBy, { marketplaceId, items }) => { createdJob = { createdBy, marketplaceId, items }; return { id: 'J1', total: items.length }; },
  getAdminCatalogJob: async (id) => (id === 'J1' ? { id, status: 'polling' } : null),
  listAdminCatalogJobs: async () => [{ id: 'J1', status: 'polling' }],
});
let pushCalls = [];
let pushBehavior = async () => ({ draft: { id: 'D1' }, categoryCarried: true });
let lastListQuery = null;
let bulkPushCalls = [];
let bulkPushBehavior = async () => ({ results: [], summary: { pushed: 0, alreadyHave: 0, failed: 0, notFound: 0 } });
stub('models/productCatalogModel', {
  listCatalogItems: async ({ page, limit, marketplaceId }) => { lastListQuery = { page, limit, marketplaceId }; return { items: [], total: 0, page: Number(page) || 1, pages: 1, limitSeen: limit }; },
  listMarketplaceCounts: async () => [{ marketplaceId: 'EBAY_GB', count: 1 }, { marketplaceId: 'EBAY_US', count: 2 }],
  deleteCatalogItem: async (id) => id === 'EXISTS',
  pushCatalogItemToUserDrafts: async (id, userId) => { pushCalls.push({ id, userId }); return pushBehavior(); },
  pushCatalogItemsToUserDrafts: async (ids, userId) => { bulkPushCalls.push({ ids, userId }); return bulkPushBehavior(); },
});

const adminRoutes = require('../routes/admin');
const handler = (method, p) => { const l = adminRoutes.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, req) => { const res = fakeRes(); await handler(method, p)({ userId: 'admin1', body: {}, query: {}, params: {}, ...req }, res); return res; };

(async () => {
  // ---------- POST fetch: mixed URL + bare ASIN, dedup, country from the URL vs from the chosen marketplace ----------
  let res = await call('post', '/product-catalog/fetch', { body: { marketplaceId: 'EBAY_GB', amazonUrls: ['https://www.amazon.co.uk/dp/B0ONE00001', 'B0TWO00002', 'https://www.amazon.co.uk/dp/B0ONE00001', '  '] } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.total, 2, 'the duplicate and the blank line do not count');
  assert.deepStrictEqual(createdJob.items.map((i) => i.asin).sort(), ['B0ONE00001', 'B0TWO00002']);
  const byAsin = Object.fromEntries(createdJob.items.map((i) => [i.asin, i]));
  assert.strictEqual(byAsin.B0ONE00001.country, 'GB', 'detected from the amazon.co.uk URL itself');
  assert.strictEqual(byAsin.B0TWO00002.country, 'GB', 'a bare ASIN falls back to the chosen marketplace\'s own country');
  assert.strictEqual(byAsin.B0TWO00002.amazonUrl, null);
  assert.strictEqual(createdJob.marketplaceId, 'EBAY_GB');

  // ---------- an unsupported marketplace is refused before anything is parsed ----------
  res = await call('post', '/product-catalog/fetch', { body: { marketplaceId: 'EBAY_ZZ', amazonUrls: ['B0SOMEASIN'] } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /Unsupported eBay marketplace/);

  // ---------- junk input: nothing valid in the list ----------
  res = await call('post', '/product-catalog/fetch', { body: { marketplaceId: 'EBAY_US', amazonUrls: ['not a url or asin', 'https://example.com/not-amazon'] } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.skipped.length, 2);

  // ---------- GET job progress / list ----------
  res = await call('get', '/product-catalog/jobs/:id', { params: { id: 'J1' } });
  assert.deepStrictEqual(res.body.job, { id: 'J1', status: 'polling' });
  res = await call('get', '/product-catalog/jobs/:id', { params: { id: 'nope' } });
  assert.strictEqual(res.statusCode, 404);
  res = await call('get', '/product-catalog/jobs', {});
  assert.strictEqual(res.body.jobs.length, 1);

  // ---------- GET catalog list: page/limit/marketplaceId passed through ----------
  res = await call('get', '/product-catalog', { query: { page: '2', limit: '50' } });
  assert.strictEqual(res.body.page, 2);
  assert.strictEqual(res.body.limitSeen, '50');
  assert.strictEqual(lastListQuery.marketplaceId, undefined, 'no marketplace filter: every section\'s own call passes none');
  res = await call('get', '/product-catalog', { query: { marketplaceId: 'EBAY_GB' } });
  assert.strictEqual(lastListQuery.marketplaceId, 'EBAY_GB');

  // ---------- GET marketplace counts: the Admin Panel's per-marketplace sections ----------
  res = await call('get', '/product-catalog/marketplaces', {});
  assert.deepStrictEqual(res.body.marketplaces, [{ marketplaceId: 'EBAY_GB', count: 1 }, { marketplaceId: 'EBAY_US', count: 2 }]);

  // ---------- DELETE: 404 when it is already gone ----------
  res = await call('delete', '/product-catalog/:id', { params: { id: 'EXISTS' } });
  assert.strictEqual(res.statusCode, 200);
  res = await call('delete', '/product-catalog/:id', { params: { id: 'GONE' } });
  assert.strictEqual(res.statusCode, 404);

  // ---------- POST push: a bad email, an unknown email, then a real push ----------
  res = await call('post', '/product-catalog/:id/push', { params: { id: 'C1' }, body: { email: 'not-an-email' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/product-catalog/:id/push', { params: { id: 'C1' }, body: { email: 'stranger@example.com' } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(pushCalls.length, 0);
  res = await call('post', '/product-catalog/:id/push', { params: { id: 'C1' }, body: { email: 'seller@example.com' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(pushCalls[0], { id: 'C1', userId: 'seller1' });
  assert.strictEqual(res.body.draft.id, 'D1');
  assert.strictEqual(res.body.categoryCarried, true);

  // ---------- POST push: the model's own error (e.g. already listed) is passed through with its status code ----------
  pushBehavior = async () => { const e = new Error('This product already exists as a live listing.'); e.statusCode = 409; throw e; };
  res = await call('post', '/product-catalog/:id/push', { params: { id: 'C1' }, body: { email: 'seller@example.com' } });
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /already exists/);

  // ---------- POST push-bulk: validation, then a real call delegates ids + the resolved userId ----------
  res = await call('post', '/product-catalog/push-bulk', { body: { ids: ['C1', 'C2'], email: 'not-an-email' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/product-catalog/push-bulk', { body: { ids: [], email: 'seller@example.com' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /non-empty array/);
  res = await call('post', '/product-catalog/push-bulk', { body: { ids: Array.from({ length: 201 }, (_, i) => 'C' + i), email: 'seller@example.com' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /at most 200/);
  res = await call('post', '/product-catalog/push-bulk', { body: { ids: ['C1', 'C2'], email: 'stranger@example.com' } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(bulkPushCalls.length, 0);
  bulkPushBehavior = async () => ({ results: [{ id: 'C1', status: 'pushed' }, { id: 'C2', status: 'already_have', reason: 'Already in Drafts.' }], summary: { pushed: 1, alreadyHave: 1, failed: 0, notFound: 0 } });
  res = await call('post', '/product-catalog/push-bulk', { body: { ids: ['C1', 'C2', 'C1'], email: 'seller@example.com' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(bulkPushCalls[0], { ids: ['C1', 'C2'], userId: 'seller1' }, 'the same id twice is sent once' );
  assert.deepStrictEqual(res.body.summary, { pushed: 1, alreadyHave: 1, failed: 0, notFound: 0 });

  console.log('admin catalog routes tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
