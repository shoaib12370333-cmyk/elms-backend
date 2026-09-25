// A payment is credited exactly once and is never "recorded but not credited": retries after a failure, two reports at the same moment,
// payments recorded by the old code, an account that changes while the payment is given, and the Paddle route on the same path.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const { fakeUsers } = require('./helpers/fakeUsers');

const U1 = '1'.repeat(24);
const users = new Map();
const purchases = new Map();
const alerts = [];
const receipts = [];
const commissions = [];
const ctl = { failRecord: false, raceRecord: false, interfere: false };
const plan = { id: 'a'.repeat(24), name: 'Starter', priceUsd: 10, credits: 500, maxEbayAccounts: 2, active: true };

stub('models/purchasesModel', {
  recordPurchase: async (p) => {
    if (ctl.failRecord) { ctl.failRecord = false; throw new Error('database hiccup'); }
    if (ctl.raceRecord) { ctl.raceRecord = false; purchases.set(p.providerTransactionId, { ...p, id: 'other' }); throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); }
    if (purchases.has(p.providerTransactionId)) return null;
    const row = { ...p, id: 'p' + (purchases.size + 1) };
    purchases.set(p.providerTransactionId, row);
    return row;
  },
  purchaseExists: async (tx) => purchases.has(tx),
  getByTransactionId: async (tx) => purchases.get(tx) || null,
});
stub('models/usersModel', { getUserById: async (id) => (users.has(id) ? { id, ...users.get(id) } : null) });
stub('models/schemas/User', fakeUsers(users, {
  beforeUpdate: (filter) => {
    // another purchase / an admin changes the plan between the read and the write of the grant
    if (ctl.interfere && filter.processedPayments) { ctl.interfere = false; users.get(U1).planExpiresAt = new Date(Date.now() + 10 * 86400000); }
  },
}));
stub('services/emailService', { sendAdminAlert: async (m) => { alerts.push(m); }, sendPurchaseReceiptEmail: async (m) => { receipts.push(m); }, sendPlanEndedEmail: async () => {} });
stub('services/affiliateService', { recordCommission: async (p) => { commissions.push(p); return null; } });
stub('services/referralService', { afterPurchase: async () => {} });
stub('services/voucherService', { markUsedForPurchase: async () => true });
stub('models/plansModel', { getPlanByPaddlePriceId: async (id) => (id === 'pri_1' ? plan : null) });
stub('services/paddleService', { EventName: { TransactionCompleted: 'transaction.completed' }, verifyAndParseWebhook: async (body) => JSON.parse(String(body)) });

const { fulfillPurchase } = require('../services/purchaseFulfillmentService');
const paddle = require('../routes/paddleWebhook');

const reset = () => {
  users.clear(); purchases.clear(); alerts.length = 0; receipts.length = 0; commissions.length = 0;
  Object.assign(ctl, { failRecord: false, raceRecord: false, interfere: false });
  users.set(U1, { email: 'buyer@x.com', creditBalance: 5, maxEbayAccounts: 1, planExpiresAt: null });
};
const pay = (over = {}) => fulfillPurchase({ userId: U1, plan, provider: 'cashtap', transactionId: 'T1', priceUsd: 10, ...over });
const credits = () => users.get(U1).creditBalance;

(async () => {
  // ---- the normal case: credits, limit, plan name, the payment noted on the user, the row, one receipt
  reset();
  let out = await pay();
  assert.strictEqual(out.granted, true);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(users.get(U1).maxEbayAccounts, 2);
  assert.strictEqual(users.get(U1).planName, 'Starter');
  assert.deepStrictEqual(users.get(U1).processedPayments, ['T1']);
  assert.strictEqual(purchases.size, 1);
  assert.strictEqual(receipts.length, 1);
  out = await pay();
  assert.deepStrictEqual([out.granted, out.duplicate], [false, true], 'reported again: nothing more');
  assert.strictEqual(credits(), 505);
  assert.strictEqual(receipts.length, 1);

  // ---- the row could not be saved (database hiccup) AFTER the credits were given: the buyer has them, the owner is told, the retry writes the row
  reset(); ctl.failRecord = true;
  await assert.rejects(() => pay(), /database hiccup/);
  assert.strictEqual(credits(), 505, 'the buyer has the credits');
  assert.strictEqual(purchases.size, 0);
  assert.strictEqual(receipts.length, 0);
  assert.match(alerts[0].subject, /credited but its record could not be saved/);
  out = await pay(); // the provider (or the return page) reports the payment again
  assert.strictEqual(out.granted, true, 'the retry finishes the job');
  assert.strictEqual(credits(), 505, 'and does not give the credits a second time');
  assert.strictEqual(purchases.size, 1);
  assert.strictEqual(receipts.length, 1);
  assert.deepStrictEqual(users.get(U1).processedPayments, ['T1']);
  out = await pay();
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(credits(), 505);

  // ---- three reports at the same moment: credited once, one of them "granted", one row, one receipt
  reset();
  const all = await Promise.all([pay(), pay(), pay()]);
  assert.strictEqual(all.filter((r) => r.granted).length, 1);
  assert.strictEqual(all.filter((r) => r.duplicate).length, 2);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(purchases.size, 1);
  assert.strictEqual(receipts.length, 1);

  // ---- the other report wrote the row a moment before ours (unique index): a duplicate, and the credits are not given again
  reset();
  Object.assign(users.get(U1), { creditBalance: 505, processedPayments: ['T1'], maxEbayAccounts: 2, planName: 'Starter' }); // what that other report gave
  ctl.raceRecord = true;
  out = await pay();
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(receipts.length, 0, 'the report that wrote the row sends the receipt, not this one');

  // ---- a payment recorded by the old code (a row, but no note on the user) is finished: nothing is given
  reset();
  purchases.set('OLD', { providerTransactionId: 'OLD', userId: U1, priceUsd: 10, id: 'old1' });
  out = await pay({ transactionId: 'OLD' });
  assert.deepStrictEqual([out.granted, out.duplicate], [false, true]);
  assert.strictEqual(credits(), 5);
  assert.strictEqual(commissions.length, 1, 'but its affiliate commission is made sure of (one per purchase, so a repeat changes nothing)');
  assert.strictEqual(commissions[0].id, 'old1');
  out = await pay({ transactionId: 'OLD', silent: true });
  assert.strictEqual(commissions.length, 1, 'a free plan from a voucher earns nobody a commission');

  // ---- the account changes between the read and the write of the grant: it is read again and the term stacks on the new end date
  reset();
  ctl.interfere = true;
  out = await pay({ plan: { ...plan, termMonths: 1, billing: 'monthly' } });
  assert.strictEqual(out.granted, true);
  assert.strictEqual(credits(), 505, 'still once');
  const ends = +users.get(U1).planExpiresAt;
  assert.ok(ends > Date.now() + 36 * 86400000 && ends < Date.now() + 42 * 86400000, 'one month on from the end that was there (10 days ahead), got ' + (ends - Date.now()) / 86400000 + ' days');
  assert.deepStrictEqual(users.get(U1).processedPayments, ['T1']);

  // ---- a payment for an account that does not exist: nobody is credited, no row, the owner is told
  reset();
  out = await pay({ userId: '9'.repeat(24), transactionId: 'GHOST' });
  assert.deepStrictEqual([out.granted, out.reason], [false, 'user_missing']);
  assert.strictEqual(purchases.size, 0);
  assert.match(alerts[0].subject, /does not exist/);

  // ---- only the newest payment ids are kept on the user
  reset();
  for (let i = 0; i < 205; i++) await pay({ transactionId: 'P' + i });
  assert.strictEqual(users.get(U1).processedPayments.length, 200);
  assert.strictEqual(users.get(U1).processedPayments.at(-1), 'P204');
  assert.strictEqual(credits(), 5 + 205 * 500);

  // ---- a free plan (voucher): given once, no receipt, no commission
  reset();
  out = await pay({ transactionId: 'voucher_1', priceUsd: 0, provider: 'voucher', silent: true });
  assert.strictEqual(out.granted, true);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(receipts.length, 0);
  assert.strictEqual(commissions.length, 0);

  // ---- the Paddle route uses the same path: credited once, a failure answers 500 so Paddle retries, a bad user id is not retried
  const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const paddleHandler = paddle.stack.find((l) => l.route && l.route.methods.post).route.stack[0].handle;
  const event = (over = {}) => ({ eventType: 'transaction.completed', data: { id: 'txn_1', customData: { elmsUserId: U1 }, items: [{ price: { id: 'pri_1' } }], details: { totals: { total: '1000' } }, payments: [{ method_details: { type: 'paypal' } }], ...over } });
  const deliver = async (ev) => { const res = fakeRes(); await paddleHandler({ headers: { 'paddle-signature': 'x' }, body: Buffer.from(JSON.stringify(ev)) }, res); return res; };

  reset();
  let res = await deliver(event());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(users.get(U1).planName, 'Starter', 'the plan name and the eBay-account limit are given like for every other payment');
  assert.strictEqual(purchases.get('txn_1').paymentMethod, 'PayPal');
  assert.strictEqual(purchases.get('txn_1').priceUsd, 10);
  res = await deliver(event()); // Paddle delivers again
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(credits(), 505);
  assert.strictEqual(receipts.length, 1);

  reset(); ctl.failRecord = true;
  res = await deliver(event());
  assert.strictEqual(res.statusCode, 500, 'Paddle is told to retry');
  assert.strictEqual(credits(), 505);
  res = await deliver(event());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(credits(), 505, 'the retry does not credit again');
  assert.strictEqual(purchases.size, 1);

  reset();
  res = await deliver(event({ customData: { elmsUserId: 'not-an-id' } }));
  assert.strictEqual(res.statusCode, 200, 'a payment with no usable user is not retried');
  res = await deliver(event({ items: [{ price: { id: 'unknown' } }] }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(credits(), 5);
  assert.strictEqual(purchases.size, 0);

  console.log('fulfillmentAtomic tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
