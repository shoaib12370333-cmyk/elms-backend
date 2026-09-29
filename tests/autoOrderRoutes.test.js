// Route-level test for the Auto Order browser extension's own endpoints (routes/autoOrder.js): the extension
// authenticates exactly like the web app (a normal session token from the extension-key exchange), so this only
// needs the usual requireAuth stub, not a separate auth system.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let orders = {};
let credits = true;
let dailyOk = true;
let primeOnly = true;
let placedCalls = [];
let retryOrder = null;
let linkedOrder = null;
let retryCalls = [];

stub('models/supplierOrdersModel', {
  getSupplierOrderById: async (userId, id) => (orders[id] && orders[id].userId === userId ? { ...orders[id] } : null),
  listSupplierOrders: async (userId, { status } = {}) => Object.values(orders).filter((o) => o.userId === userId && (!status || o.status === status)),
  claimNextReadyOrder: async (userId) => {
    const found = Object.values(orders).find((o) => o.userId === userId && o.status === 'ready');
    if (!found) return null;
    found.status = 'checking';
    return { ...found };
  },
  markPlacing: async (userId, id) => { const o = orders[id]; if (!o || o.userId !== userId || o.status !== 'checking') return null; o.status = 'placing'; return { ...o }; },
  markNeedsAttention: async (userId, id, reason) => { const o = orders[id]; if (!o) return null; o.status = 'needs_attention'; o.error = reason; return { ...o }; },
  markFailed: async (userId, id, reason) => { const o = orders[id]; if (!o) return null; o.status = 'failed'; o.error = reason; return { ...o }; },
  retrySupplierOrder: async (userId, id, opts) => { retryCalls.push({ userId, id, ...opts }); const o = orders[id]; if (!o || !['needs_attention', 'failed'].includes(o.status)) return null; o.status = 'ready'; return { ...o }; },
});
stub('models/ordersModel', { getOrderById: async () => retryOrder, linkAmazonOrder: async (u, id, amazonOrderId) => { linkedOrder = { id, amazonOrderId }; } });
stub('services/autoOrderService', {
  hasCredits: async () => credits,
  withinDailyLimit: async () => dailyOk,
  primeOnlySetting: async () => primeOnly,
  completeSupplierOrderPlacement: async (userId, id, body) => {
    placedCalls.push({ userId, id, body });
    const o = orders[id]; if (!o) return null; o.status = 'placed'; o.amazonOrderId = body.amazonOrderId; return { ...o };
  },
});
stub('config/actionCosts', { ACTION_COSTS: { AUTO_ORDER: 1 } });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => { req.userId = req.headers['x-test-user'] || 'u1'; next(); } });

const orig = Module._load;
Module._load = function (request, parent) { return orig.apply(this, arguments); };
const router = require('../routes/autoOrder');
Module._load = orig;

const call = async (method, path, { body, userId = 'u1', params = {} } = {}) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = { userId, headers: { 'x-test-user': userId }, body: body || {}, params, query: {} };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  for (const h of handlers) { let nextCalled = false; await h(req, res, () => { nextCalled = true; }); if (!nextCalled && res.body !== undefined) break; }
  return res;
};

(async () => {
  // ---------- GET /next: no credits at all -> nothing handed out, order stays 'ready' ----------
  orders = { s1: { id: 's1', userId: 'u1', status: 'ready', max_allowed_cost: 20 } };
  credits = false;
  let res = await call('get', '/next', {});
  assert.deepStrictEqual([res.body.success, res.body.order], [true, null]);
  assert.strictEqual(res.body.reason, 'out_of_credits');
  assert.strictEqual(orders.s1.status, 'ready', 'never claimed while out of credits');

  // ---------- GET /next: credits ok, daily limit reached -> claimed then immediately sent to needs_attention ----------
  credits = true; dailyOk = false;
  res = await call('get', '/next', {});
  assert.strictEqual(res.body.order, null);
  assert.strictEqual(res.body.reason, 'daily_limit');
  assert.strictEqual(orders.s1.status, 'needs_attention');

  // ---------- GET /next: the happy path, claims and returns it, with the seller's Prime-only setting alongside ----------
  orders = { s2: { id: 's2', userId: 'u1', status: 'ready', max_allowed_cost: 20 } };
  dailyOk = true;
  primeOnly = false;
  res = await call('get', '/next', {});
  assert.strictEqual(res.body.order.id, 's2');
  assert.strictEqual(orders.s2.status, 'checking');
  assert.strictEqual(res.body.settings.primeOnly, false);
  primeOnly = true;

  // ---------- POST /:id/placing: only from 'checking' ----------
  res = await call('post', '/:id/placing', { params: { id: 's2' } });
  assert.strictEqual(res.body.order.status, 'placing');
  res = await call('post', '/:id/placing', { params: { id: 's2' } }); // already 'placing' now, not 'checking'
  assert.strictEqual(res.statusCode, 404);

  // ---------- POST /:id/placed: requires an amazonOrderId; links the ELMS order and charges credit through the service ----------
  res = await call('post', '/:id/placed', { params: { id: 's2' }, body: {} });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/:id/placed', { params: { id: 's2' }, body: { amazonOrderId: 'AMZ-9', amazonTotal: 15, deliveryDate: '2026-10-05T00:00:00.000Z' } });
  assert.strictEqual(res.body.order.status, 'placed');
  assert.deepStrictEqual(placedCalls[0], { userId: 'u1', id: 's2', body: { amazonOrderId: 'AMZ-9', amazonTotal: 15, deliveryDate: '2026-10-05T00:00:00.000Z' } });

  // ---------- POST /:id/failed: needsAttention true (default) vs false route to different terminal states ----------
  orders.s3 = { id: 's3', userId: 'u1', status: 'checking' };
  res = await call('post', '/:id/failed', { params: { id: 's3' }, body: { reason: 'A captcha appeared.' } });
  assert.strictEqual(res.body.order.status, 'needs_attention');
  orders.s4 = { id: 's4', userId: 'u1', status: 'checking' };
  res = await call('post', '/:id/failed', { params: { id: 's4' }, body: { reason: 'Unexpected page.', needsAttention: false } });
  assert.strictEqual(res.body.order.status, 'failed');

  // ---------- POST /:id/retry: re-reads the address from the linked ELMS order, folding in the buyer's phone
  // (a separate field on Order) since Amazon needs one to save a new address ----------
  orders.s5 = { id: 's5', userId: 'u1', status: 'needs_attention', order_id: 'o1' };
  retryOrder = { shipping_address: { city: 'Retried City' }, buyer_phone: '+1-555-9999' };
  res = await call('post', '/:id/retry', { params: { id: 's5' } });
  assert.strictEqual(res.body.order.status, 'ready');
  assert.deepStrictEqual(retryCalls[retryCalls.length - 1].shippingAddress, { city: 'Retried City', phone: '+1-555-9999' });

  // ---------- GET / : lists only this user's orders, optionally filtered by status ----------
  res = await call('get', '/', { userId: 'u1' });
  assert.ok(res.body.orders.length >= 3);

  console.log('autoOrder routes: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
