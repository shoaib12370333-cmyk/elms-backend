// The public website shows the admin's active plans without signing in, and only the fields a visitor needs.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let provider = 'cashtap';
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('models/plansModel', {
  listActivePlans: async () => [
    { id: 'p1', name: 'Starter', priceUsd: 10, credits: 500, paddlePriceId: null, maxEbayAccounts: 1, active: true },
    { id: 'p2', name: 'Pro', priceUsd: 30, credits: 2000, paddlePriceId: 'pri_123', maxEbayAccounts: null, active: true },
  ],
  getPlanById: async () => null,
});
stub('models/purchasesModel', { listPurchasesForUser: async () => [] });
stub('models/usersModel', { getUserById: async () => null });
stub('services/paddleService', { createTransaction: async () => null });
stub('services/cashtapPaymentService', { activeProvider: () => provider });
const router = require('../routes/payments');

const layer = router.stack.find((l) => l.route && l.route.path === '/public-plans' && l.route.methods.get);
assert.ok(layer, 'the route exists');
assert.strictEqual(layer.route.stack.length, 1, 'and needs no sign-in');
const handler = layer.route.stack[0].handle;
const run = async () => { const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; }, status(c) { this.statusCode = c; return this; } }; await handler({}, res); return res; };

(async () => {
  let res = await run();
  assert.deepStrictEqual(res.body.plans, [
    { name: 'Starter', priceUsd: 10, credits: 500, maxEbayAccounts: 1 },
    { name: 'Pro', priceUsd: 30, credits: 2000, maxEbayAccounts: null },
  ]);
  assert.ok(!('id' in res.body.plans[0]) && !('paddlePriceId' in res.body.plans[1]), 'no internal ids');
  assert.match(res.headers['Cache-Control'], /max-age=300/);

  provider = 'paddle'; // only plans that can actually be sold with Paddle
  res = await run();
  assert.deepStrictEqual(res.body.plans.map((p) => p.name), ['Pro']);
  console.log('public plans tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
