// routes/listingPacks.js: the Buy Listings tab's own endpoints - list tiers, start a CashTap checkout, confirm on return.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => { req.userId = req.userId || 'u1'; next(); } });

let provider = 'cashtap';
let tiers = [{ id: 't1', name: '1,000 listings', priceUsd: 10, listingCount: 1000, active: true }];
let purchases = [];
stub('models/listingPackTiersModel', {
  listActiveTiers: async () => tiers.filter((t) => t.active),
  getTierById: async (id) => tiers.find((t) => t.id === id) || null,
});
stub('models/listingPackPurchasesModel', { listPurchasesForUser: async (userId) => purchases.filter((p) => p.userId === userId) });
stub('models/usersModel', { getUserById: async (id) => (id === 'u1' ? { id: 'u1', email: 'buyer@x.com' } : null) });

let checkoutCalls = [];
let confirmCalls = [];
let checkoutResult = { sessionId: 'cs_live_X', url: 'https://pay.cashtap.cash/c/cs_live_X' };
let confirmResult = { status: 'completed', granted: true, pushed: 950, requested: 1000, tierName: '1,000 listings' };
stub('services/cashtapPaymentService', {
  activeProvider: () => provider,
  startListingPackCheckout: async (args) => { checkoutCalls.push(args); return checkoutResult; },
  confirmListingPackSession: async (sessionId, userId) => { confirmCalls.push({ sessionId, userId }); return confirmResult; },
});

const router = require('../routes/listingPacks');
const routeHandler = (p, method) => {
  const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]);
  assert.ok(l, `route ${method.toUpperCase()} ${p} exists`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (handler, { userId = 'u1', body = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ userId, body }, res);
  return out;
};

(async () => {
  const listHandler = routeHandler('/', 'get');
  const checkoutHandler = routeHandler('/checkout', 'post');
  const confirmHandler = routeHandler('/confirm', 'post');

  // ---- listing tiers ----
  let out = await call(listHandler);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.tiers.length, 1);
  tiers.push({ id: 't2', name: 'Hidden', priceUsd: 5, listingCount: 100, active: false });
  out = await call(listHandler);
  assert.strictEqual(out.body.tiers.length, 1, 'inactive tiers are never shown');

  provider = 'paddle';
  out = await call(listHandler);
  assert.strictEqual(out.status, 404, 'no Paddle price for this - not available when CashTap is not the active provider');
  provider = 'cashtap';

  // ---- checkout ----
  out = await call(checkoutHandler, { body: { tierId: 't1' } });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body, { success: true, ...checkoutResult });
  assert.strictEqual(checkoutCalls[0].tier.id, 't1');
  assert.strictEqual(checkoutCalls[0].user.id, 'u1');

  out = await call(checkoutHandler, { body: { tierId: 't2' } });
  assert.strictEqual(out.status, 404, 'an inactive tier cannot be bought');
  out = await call(checkoutHandler, { body: { tierId: 'missing' } });
  assert.strictEqual(out.status, 404);
  out = await call(checkoutHandler, { userId: 'ghost', body: { tierId: 't1' } });
  assert.strictEqual(out.status, 404, 'user not found');

  // ---- confirm ----
  out = await call(confirmHandler, { body: { sessionId: 'cs_live_X' } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.pushed, 950);
  assert.deepStrictEqual(confirmCalls[0], { sessionId: 'cs_live_X', userId: 'u1' });

  out = await call(confirmHandler, { body: { sessionId: 'not-a-real-session-id' } });
  assert.strictEqual(out.status, 400);

  confirmResult = { status: 'completed', granted: false, reason: 'not_yours' };
  out = await call(confirmHandler, { body: { sessionId: 'cs_live_X' } });
  assert.strictEqual(out.status, 404);

  console.log('listing packs route: all good');
})().catch((err) => { console.error(err); process.exit(1); });
