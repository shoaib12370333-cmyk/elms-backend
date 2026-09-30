// "Buy Listings": paying (CashTap) for a fixed number of random ready-to-list drafts. Covers the grant (once per payment),
// the CashTap checkout/session-grant functions, and the shared webhook route branching to this path via metadata.elms_kind.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const db = { users: new Map(), purchases: new Map(), alerts: [] };
const tier = { id: 'tier1', name: '1,000 listings', priceUsd: 10, listingCount: 1000 };

stub('models/listingPackTiersModel', { getTierById: async (id) => (id === 'tier1' ? tier : null) });
stub('models/listingPackPurchasesModel', {
  purchaseExists: async (tx) => db.purchases.has(tx),
  recordPurchase: async (p) => {
    if (db.purchases.has(p.providerTransactionId)) return null;
    db.purchases.set(p.providerTransactionId, p);
    return p;
  },
});
stub('models/usersModel', { getUserById: async (id) => db.users.get(id) || null });
stub('services/emailService', { sendAdminAlert: async (m) => { db.alerts.push(m); } });

let pushCalls = [];
let pushed = 950;
stub('services/listingCloneService', {
  pushRandomListings: async (args) => { pushCalls.push(args); return { requested: args.count, poolSize: 4000, pushed }; },
});

const reset = () => { db.users.clear(); db.purchases.clear(); db.alerts.length = 0; pushCalls = []; pushed = 950; db.users.set('u1', { id: 'u1', email: 'buyer@x.com' }); };

const grantSvc = require('../services/listingPackGrantService');
const pay = require('../services/cashtapPaymentService');
const cashtap = require('../services/cashtapService');
const paidSession = (over = {}) => ({ id: 'cs_live_LISTINGPACK000000001', status: 'completed', amount: 10, amount_received: 10, metadata: { elms_kind: 'listing_pack', elms_user_id: 'u1', elms_tier_id: 'tier1' }, ...over });

(async () => {
  // ---- listingPackGrantService.grantOnce ----
  reset();
  let out = await grantSvc.grantOnce({ userId: 'u1', tier, transactionId: 'tx1' });
  assert.strictEqual(out.status, 'applied');
  assert.strictEqual(out.pushed, 950);
  assert.deepStrictEqual(pushCalls[0], { targetUserId: 'u1', count: 1000 });
  assert.strictEqual(db.purchases.size, 1);
  assert.match(db.alerts[0].subject, /Buy Listings payment: \$10\.00/);

  // reported again: not pushed twice
  out = await grantSvc.grantOnce({ userId: 'u1', tier, transactionId: 'tx1' });
  assert.strictEqual(out.status, 'already');
  assert.strictEqual(pushCalls.length, 1, 'the clone was not run a second time');

  // two reports at once: pushed once
  reset();
  const both = await Promise.all([
    grantSvc.grantOnce({ userId: 'u1', tier, transactionId: 'tx2' }),
    grantSvc.grantOnce({ userId: 'u1', tier, transactionId: 'tx2' }),
  ]);
  assert.strictEqual(both.filter((r) => r.status === 'applied').length, 1);
  assert.strictEqual(both.filter((r) => r.status === 'already').length, 1);
  assert.strictEqual(db.purchases.size, 1);

  out = await grantSvc.grantOnce({ userId: 'ghost', tier, transactionId: 'tx3' });
  assert.strictEqual(out.status, 'missing');

  // ---- cashtapPaymentService: grantForListingPackSession ----
  reset();
  out = await pay.grantForListingPackSession(paidSession());
  assert.strictEqual(out.granted, true);
  assert.strictEqual(out.pushed, 950);
  assert.strictEqual(out.tierName, '1,000 listings');

  out = await pay.grantForListingPackSession(paidSession());
  assert.strictEqual(out.granted, false);
  assert.strictEqual(out.duplicate, true);

  reset();
  for (const status of ['pending', 'processing', 'expired', 'failed']) assert.strictEqual((await pay.grantForListingPackSession(paidSession({ status }))).granted, false, status);

  reset();
  out = await pay.grantForListingPackSession(paidSession({ metadata: {} }));
  assert.strictEqual(out.reason, 'no_user');
  out = await pay.grantForListingPackSession(paidSession({ metadata: { elms_kind: 'listing_pack', elms_user_id: 'u1', elms_tier_id: 'gone' } }));
  assert.strictEqual(out.reason, 'no_tier');
  out = await pay.grantForListingPackSession(paidSession({ amount: 1, amount_received: 1 }));
  assert.strictEqual(out.reason, 'amount_mismatch');
  out = await pay.grantForListingPackSession(paidSession({ amount_received: 9.0 }));
  assert.strictEqual(out.reason, 'underpaid');
  assert.strictEqual(pushCalls.length, 0, 'nothing was ever pushed for any of these');

  out = await pay.grantForListingPackSession(paidSession(), { expectUserId: 'someone-else' });
  assert.strictEqual(out.reason, 'not_yours');

  // ---- checkout session creation ----
  let created = null;
  cashtap.createSession = async (args) => { created = args; return { id: 'cs_live_NEW', url: 'https://pay.cashtap.cash/c/cs_live_NEW' }; };
  const started = await pay.startListingPackCheckout({ user: { id: 'u1', email: 'buyer@x.com' }, tier });
  assert.deepStrictEqual(started, { sessionId: 'cs_live_NEW', url: 'https://pay.cashtap.cash/c/cs_live_NEW' });
  assert.strictEqual(created.amount, 10);
  assert.deepStrictEqual(created.metadata, { elms_kind: 'listing_pack', elms_user_id: 'u1', elms_tier_id: 'tier1' });
  assert.match(created.successUrl, /payment=cashtap&kind=listing_pack/);
  cashtap.createSession = async () => ({ id: 'cs_live_X', url: 'https://evil.example.com/pay' });
  await assert.rejects(() => pay.startListingPackCheckout({ user: { id: 'u1' }, tier }), /unexpected checkout address/);

  // ---- the shared webhook route: a listing_pack session is routed to grantForListingPackSession, a plan session is not ----
  reset();
  process.env.CASHTAP_WEBHOOK_SECRET = 'whsec_test_secret_do_not_use';
  const secret = process.env.CASHTAP_WEBHOOK_SECRET;
  const router = require('../routes/cashtapWebhook');
  const handler = router.stack.find((l) => l.route && l.route.methods.post).route.stack[0].handle;
  const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const post = async (event) => {
    const raw = Buffer.from(JSON.stringify(event));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest('hex');
    const res = fakeRes();
    await handler({ body: raw, headers: { 'x-cashtap-signature': 't=' + t + ',v1=' + sig } }, res);
    return res;
  };
  const completedEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: { id: 'cs_live_LISTINGPACK000000001', status: 'completed' } } };
  cashtap.getSession = async () => paidSession();
  const res = await post(completedEvent);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(pushCalls.length, 1, 'the webhook pushed the listings (not a credit grant)');
  assert.strictEqual(db.purchases.size, 1);

  console.log('listing pack purchase tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
