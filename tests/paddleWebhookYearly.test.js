// Paddle's webhook only gets a price id back - it has to work out which plan AND which term (monthly or yearly,
// two SEPARATE Paddle prices) a completed transaction paid for, then grant the right number of credits (planOffer()
// does the 12x for yearly, same as the CashTap checkout already does).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const EventName = { TransactionCompleted: 'transaction.completed' };
let event = null;
stub('services/paddleService', { verifyAndParseWebhook: async () => event, EventName });

const plan = { id: '64b7f0c2a1b2c3d4e5f60718', name: 'Pro', priceUsd: 120, credits: 6000, maxEbayAccounts: 2, yearlyPriceUsd: 1200, paddlePriceId: 'pri_month', paddleYearlyPriceId: 'pri_year' };
stub('models/plansModel', { getPlanByPaddlePriceId: async (id) => ([plan.paddlePriceId, plan.paddleYearlyPriceId].includes(id) ? plan : null) });

const calls = [];
stub('services/purchaseFulfillmentService', { fulfillPurchase: async (args) => { calls.push(args); return { granted: true }; } });

const router = require('../routes/paddleWebhook');
const handler = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post).route.stack[0].handle;
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const USER_ID = '64b7f0c2a1b2c3d4e5f60719';
const txn = (priceId) => ({ eventType: EventName.TransactionCompleted, data: { id: 't_' + Math.random().toString(36).slice(2), customData: { elmsUserId: USER_ID }, items: [{ price: { id: priceId } }], details: {} } });

(async () => {
  // the monthly Paddle price: one month of credits, exactly like any other Paddle grant (no local term/expiry -
  // Paddle's own recurring billing is what re-fires this webhook on renewal, so the plan name is never suffixed)
  event = txn('pri_month');
  let res = fakeRes();
  await handler({ headers: {}, body: Buffer.from('x') }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].plan.credits, calls[0].plan.name], [6000, 'Pro']);

  // the SAME plan's yearly Paddle price: twelve months of credits, not six or one - same "no local expiry" grant
  event = txn('pri_year');
  res = fakeRes();
  await handler({ headers: {}, body: Buffer.from('x') }, res);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual([calls[1].plan.credits, calls[1].plan.name], [72000, 'Pro']);

  // an unknown price id: nothing is credited, no crash, Paddle is told it was received (so it does not retry forever)
  event = txn('pri_unknown');
  res = fakeRes();
  await handler({ headers: {}, body: Buffer.from('x') }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 2, 'nothing credited for a price that maps to no plan');

  console.log('paddle webhook yearly tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
