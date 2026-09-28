// Card / other methods (Paddle) are offered next to Cash App (CashTap): the plans say which plan can be paid by card, the checkout
// obeys the buyer's choice, and nothing that Paddle cannot do (voucher, yearly, custom) slips through.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let provider = 'cashtap';
const calls = { paddle: [], cashtap: [] };
const plans = [
  { id: 'p1', name: 'Starter', priceUsd: 10, credits: 500, paddlePriceId: null, active: true },
  { id: 'p2', name: 'Pro', priceUsd: 30, credits: 2000, paddlePriceId: 'pri_123', active: true },
];
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('models/plansModel', { listActivePlans: async () => plans, getPlanById: async (id) => plans.find((p) => p.id === id) || null });
stub('models/purchasesModel', { listPurchasesForUser: async () => [], getPurchaseById: async () => null });
stub('models/usersModel', { getUserById: async () => ({ id: 'u1', email: 'a@b.co', planExpiresAt: null }) });
stub('models/settingsModel', { getCustomPlanSettings: async () => ({ enabled: false }) });
stub('services/paddleService', { createTransaction: async (a) => { calls.paddle.push(a); return { transactionId: 'txn_1' }; } });
stub('services/cashtapPaymentService', { activeProvider: () => provider, startCheckout: async (a) => { calls.cashtap.push(a); return { sessionId: 'cs_1', url: 'https://pay.cashtap.cash/x' }; } });
stub('services/referralService', { discountFor: async () => null, priceAfterDiscount: (p) => p });
stub('services/voucherService', { usableForPurchase: async () => null, appliesToPlan: () => false, priceWith: (p) => p, describe: () => '' });
const router = require('../routes/payments');

const handlerOf = (route, method) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  assert.ok(layer, route + ' exists');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (handler, req) => {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; }, status(c) { this.statusCode = c; return this; } };
  await handler({ userId: 'u1', query: {}, body: {}, ...req }, res);
  return res;
};

(async () => {
  const plansRoute = handlerOf('/plans', 'get');
  const checkout = handlerOf('/checkout', 'post');
  const publicPlans = handlerOf('/public-plans', 'get');
  delete process.env.PADDLE_API_KEY; delete process.env.PADDLE_WEBHOOK_SECRET;

  // Paddle not set up: nothing is offered, and asking for it is refused
  let res = await call(plansRoute, {});
  assert.ok(res.body.plans.every((p) => p.paddleAvailable === false), 'no card option without the Paddle secrets');
  res = await call(publicPlans, {});
  assert.strictEqual(res.body.card, false);
  res = await call(checkout, { body: { planId: 'p2', provider: 'paddle' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.paddle.length, 0);

  // Paddle set up: only the plan with a Paddle price id can be paid by card
  process.env.PADDLE_API_KEY = 'k'; process.env.PADDLE_WEBHOOK_SECRET = 's';
  res = await call(plansRoute, {});
  assert.deepStrictEqual(res.body.plans.map((p) => p.paddleAvailable), [false, true]);
  assert.strictEqual(res.body.provider, 'cashtap', 'Cash App stays the main checkout');
  res = await call(publicPlans, {});
  assert.strictEqual(res.body.card, true);

  // the buyer's choice decides
  res = await call(checkout, { body: { planId: 'p2', provider: 'paddle' } });
  assert.deepStrictEqual([res.body.success, res.body.provider, res.body.transactionId], [true, 'paddle', 'txn_1']);
  assert.strictEqual(calls.paddle[0].paddlePriceId, 'pri_123');
  res = await call(checkout, { body: { planId: 'p2' } });
  assert.strictEqual(res.body.provider, 'cashtap', 'no choice = Cash App as before');
  assert.strictEqual(calls.cashtap.length, 1);

  // what Paddle cannot do is refused, and no transaction is made
  const before = calls.paddle.length;
  res = await call(checkout, { body: { planId: 'p1', provider: 'paddle' } });
  assert.strictEqual(res.statusCode, 404, 'a plan with no Paddle price');
  res = await call(checkout, { body: { planId: 'p2', provider: 'paddle', billing: 'yearly' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call(checkout, { body: { provider: 'paddle', custom: { amountUsd: 100 } } });
  assert.strictEqual(res.statusCode, 400);
  res = await call(checkout, { body: { planId: 'p2', provider: 'paddle', voucherId: 'v1' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.paddle.length, before);

  // the old all-Paddle mode still works
  provider = 'paddle';
  res = await call(checkout, { body: { planId: 'p2' } });
  assert.strictEqual(res.body.provider, 'paddle');
  res = await call(publicPlans, {});
  assert.strictEqual(res.body.card, true);

  console.log('paddle alongside cashtap tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
