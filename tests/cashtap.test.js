// CashTap checkout: signature check (with CashTap's own test vector), giving a plan exactly once, refusing wrong
// amounts / short payments, the webhook route, and creating the checkout session.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- in-memory stand-ins
const db = { users: new Map(), purchases: new Map(), alerts: [], receipts: [] };
const plan = { id: 'plan1', name: 'Starter', priceUsd: 10, credits: 500, maxEbayAccounts: 1, active: true };
let raceOnce = false;
stub('models/plansModel', { getPlanById: async (id) => (id === 'plan1' ? plan : null) });
stub('models/purchasesModel', {
  recordPurchase: async (p) => {
    if (raceOnce) { raceOnce = false; throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); }
    if (db.purchases.has(p.providerTransactionId)) return null;
    db.purchases.set(p.providerTransactionId, p);
    return p;
  },
});
stub('models/usersModel', {
  addCredits: async (id, n) => { db.users.get(id).creditBalance += n; },
  getUserById: async (id) => ({ id, ...db.users.get(id) }),
  setMaxEbayAccounts: async (id, n) => { db.users.get(id).maxEbayAccounts = n; },
});
stub('models/schemas/User', { updateOne: async ({ _id }, u) => { Object.assign(db.users.get(String(_id)), u.$set); } });
stub('services/emailService', {
  sendAdminAlert: async (m) => { db.alerts.push(m); },
  sendPurchaseReceiptEmail: async (m) => { db.receipts.push(m); },
});
// the referral programme (tests/referral.test.js) has nobody referred here
stub('models/referralsModel', { findReferralByReferred: async () => null });
stub('models/settingsModel', { getCustomPlanSettings: async () => ({ enabled: false }), getAffiliateSettings: async () => ({ enabled: false }), getReferralSettings: async () => ({ enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 }) });
const reset = () => { db.users.clear(); db.purchases.clear(); db.alerts.length = 0; db.receipts.length = 0; db.users.set('u1', { email: 'buyer@x.com', creditBalance: 5, maxEbayAccounts: 1, planName: null }); };

const cashtap = require('../services/cashtapService');
const pay = require('../services/cashtapPaymentService');
const paid = (over = {}) => ({ id: 'cs_live_AAAAAAAAAAAAAAAAAAAAAA', status: 'completed', amount: 10, amount_received: 10, metadata: { elms_user_id: 'u1', elms_plan_id: 'plan1' }, ...over });

(async () => {
  // ---- signature: CashTap's published test vector (its timestamp is fixed, so the tolerance is switched off)
  const secret = 'whsec_test_secret_do_not_use';
  const body = '{"id":"evt_123","type":"checkout.session.completed"}';
  const v1 = '66a710e3cc2913be941031d9e7691c085570a75feb121fa1cc59070421dd44a2';
  const header = 't=1767225600,v1=' + v1;
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body), header, secret, null), true, 'the vector is accepted');
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body + ' '), header, secret, null), false, 'one changed character is refused');
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body), header, 'whsec_other', null), false, 'another secret is refused');
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body), header, secret), false, 'an old timestamp is refused (replay)');
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body), 't=1767225600,v1=' + 'a'.repeat(64) + ',v1=' + v1, secret, null), true, 'any of several v1 may match (rotated secret)');
  for (const bad of [undefined, '', 'garbage', 't=abc,v1=' + v1, 't=1767225600', 't=1767225600,v1=nothex']) assert.strictEqual(cashtap.verifySignature(Buffer.from(body), bad, secret, null), false, String(bad));
  const nowT = Math.floor(Date.now() / 1000);
  const fresh = crypto.createHmac('sha256', secret).update(nowT + '.' + body).digest('hex');
  assert.strictEqual(cashtap.verifySignature(Buffer.from(body), 't=' + nowT + ',v1=' + fresh, secret), true);

  // ---- giving the plan
  reset();
  let out = await pay.grantForSession(paid());
  assert.strictEqual(out.granted, true);
  assert.strictEqual(db.users.get('u1').creditBalance, 505);
  assert.strictEqual(db.users.get('u1').planName, 'Starter');
  assert.strictEqual(db.purchases.size, 1);
  assert.strictEqual(db.receipts.length, 1);
  assert.strictEqual(db.alerts[0].subject, 'New payment: $10.00');

  // reported again (webhook retry / return page): nothing is given twice
  out = await pay.grantForSession(paid());
  assert.strictEqual(out.granted, false);
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(db.users.get('u1').creditBalance, 505);
  // two requests at the same moment: the loser hits the unique index and is told it is a duplicate
  raceOnce = true;
  out = await pay.grantForSession(paid({ id: 'cs_live_BBBBBBBBBBBBBBBBBBBBBB' }));
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(db.users.get('u1').creditBalance, 505);

  // the eBay-account limit is raised, never lowered
  reset(); db.users.get('u1').maxEbayAccounts = 0;
  await pay.grantForSession(paid());
  assert.strictEqual(db.users.get('u1').maxEbayAccounts, 1);
  reset(); db.users.get('u1').maxEbayAccounts = 3;
  await pay.grantForSession(paid());
  assert.strictEqual(db.users.get('u1').maxEbayAccounts, 3, 'an admin gave 3; buying the 1-account plan does not take it away');

  // not paid yet
  reset();
  for (const status of ['pending', 'processing', 'expired', 'failed']) assert.strictEqual((await pay.grantForSession(paid({ status }))).granted, false, status);
  assert.strictEqual(db.users.get('u1').creditBalance, 5);

  // a session with the wrong amount, a plan that is gone, no user: nothing is given and the admin is told
  reset();
  out = await pay.grantForSession(paid({ amount: 1, amount_received: 1 }));
  assert.strictEqual(out.reason, 'amount_mismatch'); assert.strictEqual(db.alerts.length, 1);
  out = await pay.grantForSession(paid({ metadata: { elms_user_id: 'u1', elms_plan_id: 'gone' } }));
  assert.strictEqual(out.reason, 'no_plan');
  out = await pay.grantForSession(paid({ metadata: {} }));
  assert.strictEqual(out.reason, 'no_user');
  assert.strictEqual(db.alerts.length, 3);
  assert.strictEqual(db.users.get('u1').creditBalance, 5);

  // short payments: within 5% is fine (bridge fees), beyond it the admin decides
  reset();
  out = await pay.grantForSession(paid({ amount_received: 9.6 }));
  assert.strictEqual(out.granted, true);
  reset();
  out = await pay.grantForSession(paid({ amount_received: 9.0 }));
  assert.strictEqual(out.reason, 'underpaid');
  assert.strictEqual(db.users.get('u1').creditBalance, 5);
  assert.match(db.alerts[0].lines.join(' '), /9 of \$10/);

  // the return-page check: only the buyer can trigger / see it
  reset();
  out = await pay.grantForSession(paid(), { expectUserId: 'someone-else' });
  assert.strictEqual(out.reason, 'not_yours');
  assert.strictEqual(db.users.get('u1').creditBalance, 5);

  // ---- checkout session
  let created = null;
  cashtap.createSession = async (args) => { created = args; return { id: 'cs_live_NEW', url: 'https://pay.cashtap.cash/c/cs_live_NEW' }; };
  const started = await pay.startCheckout({ user: { id: 'u1', email: 'buyer@x.com' }, plan });
  assert.deepStrictEqual(started, { sessionId: 'cs_live_NEW', url: 'https://pay.cashtap.cash/c/cs_live_NEW' });
  assert.strictEqual(created.amount, 10, 'the price is the plan\'s');
  assert.deepStrictEqual(created.metadata, { elms_user_id: 'u1', elms_plan_id: 'plan1' });
  assert.match(created.lineItems[0].description, /500 credits \+ 1 eBay account$/);
  assert.match(created.successUrl, /payment=cashtap/);
  cashtap.createSession = async () => ({ id: 'cs_live_X', url: 'https://evil.example.com/pay' });
  await assert.rejects(() => pay.startCheckout({ user: { id: 'u1' }, plan }), /unexpected checkout address/);

  // ---- which provider
  delete process.env.PAYMENT_PROVIDER; delete process.env.CASHTAP_SECRET_KEY;
  assert.strictEqual(pay.activeProvider(), 'paddle', 'no CashTap key yet -> the old checkout keeps working');
  process.env.CASHTAP_SECRET_KEY = 'sk_live_x';
  assert.strictEqual(pay.activeProvider(), 'cashtap');
  process.env.PAYMENT_PROVIDER = 'paddle';
  assert.strictEqual(pay.activeProvider(), 'paddle');
  delete process.env.PAYMENT_PROVIDER;

  // ---- the webhook route
  process.env.CASHTAP_WEBHOOK_SECRET = secret;
  const router = require('../routes/cashtapWebhook');
  const handler = router.stack.find((l) => l.route && l.route.methods.post).route.stack[0].handle;
  const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const post = async (event, sign = true) => {
    const raw = Buffer.from(JSON.stringify(event));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest('hex');
    const res = fakeRes();
    await handler({ body: raw, headers: { 'x-cashtap-signature': sign ? 't=' + t + ',v1=' + sig : 't=' + t + ',v1=' + 'b'.repeat(64) } }, res);
    return res;
  };
  const completedEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: { id: 'cs_live_AAAAAAAAAAAAAAAAAAAAAA', status: 'completed' } } };

  reset();
  assert.strictEqual((await post(completedEvent, false)).statusCode, 400, 'a forged request is refused');
  assert.strictEqual(db.purchases.size, 0);
  const test = await post({ ...completedEvent, livemode: false });
  assert.strictEqual(test.statusCode, 200); assert.strictEqual(test.body.ignored, 'test event');

  let fetched = 0;
  cashtap.getSession = async () => { fetched += 1; return paid(); };
  let res = await post(completedEvent);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(fetched, 1, 'the session is fetched from CashTap, the webhook body is not trusted');
  assert.strictEqual(db.users.get('u1').creditBalance, 505);
  res = await post(completedEvent); // CashTap retries: nothing more is given
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.users.get('u1').creditBalance, 505);

  // the event says "completed" but CashTap's own answer says it is not: nothing is given
  reset();
  cashtap.getSession = async () => paid({ status: 'pending' });
  await post(completedEvent);
  assert.strictEqual(db.users.get('u1').creditBalance, 5);
  // unknown session -> acknowledged; a temporary CashTap problem -> 500 so CashTap retries
  cashtap.getSession = async () => { throw Object.assign(new Error('nope'), { statusCode: 404 }); };
  assert.strictEqual((await post(completedEvent)).statusCode, 200);
  cashtap.getSession = async () => { throw Object.assign(new Error('down'), { statusCode: 503 }); };
  assert.strictEqual((await post(completedEvent)).statusCode, 500);

  // failed settlement -> the admin is told, nobody is credited
  reset();
  res = await post({ id: 'evt_2', type: 'checkout.session.failed', livemode: true, data: { object: { id: 'cs_live_F', amount: 10, metadata: {} } } });
  assert.strictEqual(res.statusCode, 200);
  assert.match(db.alerts[0].subject, /failed to settle/);
  assert.strictEqual(db.users.get('u1').creditBalance, 5);

  console.log('cashtap tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
