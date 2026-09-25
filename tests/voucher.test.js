// Vouchers: an admin gives one to a user (credits / a free plan / eBay accounts / a discount at checkout); only the owner can use it, once;
// the checkout price and the payment check with a voucher; the routes for the user and for the admin.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---------- in-memory stand-ins ----------
const db = { vouchers: [], users: new Map(), credits: {}, slots: {}, purchases: [], alerts: [], mails: [], receipts: [], sessions: [], seq: 0, failCredits: false, referral: null };
const hex = () => String(++db.seq).padStart(24, 'b');
const plans = [
  { id: 'a'.repeat(24), name: 'Starter', priceUsd: 10, credits: 500, maxEbayAccounts: 1, active: true },
  { id: 'c'.repeat(24), name: 'Growth', priceUsd: 25, credits: 1500, maxEbayAccounts: 2, active: true },
];
const STARTER = plans[0];
const GROWTH = plans[1];
const U1 = '1'.repeat(24);
const U2 = '2'.repeat(24);
const ADMIN = '9'.repeat(24);

const vouchersModel = {
  create: async (f) => { const v = { id: hex(), userId: String(f.userId), kind: f.kind, percent: f.percent ?? null, amountUsd: f.amountUsd ?? null, planId: f.planId ? String(f.planId) : null, credits: f.credits ?? null, ebayAccounts: f.ebayAccounts ?? null, note: f.note || '', expiresAt: f.expiresAt || null, status: 'active', usedAt: null, usedFor: null, revokedAt: null, createdAt: new Date() }; db.vouchers.push(v); return { ...v }; },
  getById: async (id) => { const v = db.vouchers.find((x) => x.id === id); return v ? { ...v } : null; },
  listForUser: async (uid) => db.vouchers.filter((v) => v.userId === String(uid)).map((v) => ({ ...v })).reverse(),
  claim: async (id, uid, usedFor) => { const v = db.vouchers.find((x) => x.id === id && x.userId === String(uid) && x.status === 'active'); if (!v) return null; v.status = 'used'; v.usedAt = new Date(); v.usedFor = usedFor; return { ...v }; },
  release: async (id) => { const v = db.vouchers.find((x) => x.id === id && x.status === 'used'); if (v) { v.status = 'active'; v.usedAt = null; v.usedFor = null; } },
  revoke: async (id) => { const v = db.vouchers.find((x) => x.id === id && x.status === 'active'); if (!v) return null; v.status = 'revoked'; return { ...v }; },
  adminList: async ({ status, kind, userIds } = {}) => db.vouchers.filter((v) => (!status || v.status === status) && (!kind || v.kind === kind) && (!userIds || userIds.includes(v.userId))).map((v) => ({ ...v })).reverse(),
  adminCounts: async () => ({ active: db.vouchers.filter((v) => v.status === 'active').length, used: db.vouchers.filter((v) => v.status === 'used').length, revoked: db.vouchers.filter((v) => v.status === 'revoked').length }),
};
stub('models/vouchersModel', vouchersModel);
stub('models/plansModel', { getPlanById: async (id) => plans.find((p) => p.id === String(id)) || null, listActivePlans: async () => plans });
stub('models/usersModel', {
  addCredits: async (id, n) => { if (db.failCredits) throw new Error('db down'); db.credits[id] = (db.credits[id] || 0) + n; },
  addEbayAccountSlots: async (id, n) => { db.slots[id] = (db.slots[id] || 0) + n; },
  getUserById: async (id) => (db.users.has(id) ? { id, ...db.users.get(id) } : null),
  setMaxEbayAccounts: async (id, n) => { db.slots[id] = n; },
});
stub('models/purchasesModel', {
  recordPurchase: async (p) => { if (db.purchases.some((x) => x.providerTransactionId === p.providerTransactionId)) return null; db.purchases.push(p); return p; },
  listPurchasesForUser: async () => [],
});
stub('models/schemas/User', { updateOne: async () => {} });
stub('models/settingsModel', { getCustomPlanSettings: async () => ({ enabled: false }), getReferralSettings: async () => ({ enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 }) });
stub('models/referralsModel', {
  findReferralByReferred: async (id) => (db.referral && db.referral.referredUserId === String(id) ? db.referral : null),
  getUser: async (id) => (db.users.has(String(id)) ? { id: String(id), ...db.users.get(String(id)) } : null),
  getUsersByIds: async (ids) => new Map(ids.filter((i) => db.users.has(String(i))).map((i) => [String(i), { id: String(i), ...db.users.get(String(i)) }])),
  searchUsers: async (q) => [...db.users.entries()].filter(([, u]) => u.email.includes(String(q).toLowerCase())).map(([id, u]) => ({ id, ...u })),
  incDiscounted: async () => { db.referral.discountedPurchases++; },
  recordPurchaseOn: async () => {},
  claimReward: async () => null,
});
stub('services/emailService', {
  sendAdminAlert: async (m) => { db.alerts.push(m); },
  sendPurchaseReceiptEmail: async (m) => { db.receipts.push(m); },
  sendVoucherEmail: async (m) => { db.mails.push(m); },
});
stub('services/cashtapService', { createSession: async (s) => { const id = 'cs_live_' + String(db.sessions.length + 1).padStart(22, 'A'); db.sessions.push({ ...s, id }); return { id, url: 'https://pay.cashtap.cash/x', amount: s.amount }; }, isConfigured: () => true });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next() });

const vouchers = require('../services/voucherService');
const pay = require('../services/cashtapPaymentService');
const userRoutes = require('../routes/vouchers');
const adminRoutes = require('../routes/adminVouchers');
const paymentRoutes = require('../routes/payments');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = () => r; return r; };
const call = async (router, method, p, req) => { const res = fakeRes(); await handler(router, method, p)({ userId: U1, body: {}, query: {}, params: {}, headers: {}, ...req }, res); return res; };
const reset = () => {
  db.vouchers.length = 0; db.credits = {}; db.slots = {}; db.purchases.length = 0; db.alerts.length = 0; db.mails.length = 0; db.receipts.length = 0; db.sessions.length = 0; db.failCredits = false; db.referral = null;
  db.users.clear();
  db.users.set(U1, { email: 'buyer@x.com', name: 'Buyer' });
  db.users.set(U2, { email: 'other@x.com', name: 'Other' });
  db.users.set(ADMIN, { email: 'admin@x.com', name: 'Admin' });
};
const give = (userId, input) => vouchers.giveVoucher({ adminId: ADMIN, user: { id: userId, email: db.users.get(userId).email }, input });
const paid = (session, over = {}) => ({ id: session.id, status: 'completed', amount: session.amount, amount_received: session.amount, metadata: session.metadata, ...over });

(async () => {
  // ---------- the price ----------
  assert.strictEqual(vouchers.priceWith(10, { percent: 20, amountUsd: null }), 8);
  assert.strictEqual(vouchers.priceWith(10, { percent: null, amountUsd: 3 }), 7);
  assert.strictEqual(vouchers.priceWith(10, { percent: null, amountUsd: 50 }), 0.5, 'never below the $0.50 minimum');
  assert.strictEqual(vouchers.priceWith(0.5, { percent: 50, amountUsd: null }), 0.5);
  assert.strictEqual(vouchers.priceWith(10, { percent: 200, amountUsd: null }), 1, 'a silly percent is capped at 90');

  // ---------- what an admin may type ----------
  reset();
  const bad = [
    [{}, /what the voucher is for/],
    [{ kind: 'nope' }, /what the voucher is for/],
    [{ kind: 'purchase_discount' }, /either a percent off or an amount off/],
    [{ kind: 'purchase_discount', percent: 10, amountUsd: 5 }, /either a percent off or an amount off/],
    [{ kind: 'purchase_discount', percent: 0 }, /between 1 and 90/],
    [{ kind: 'purchase_discount', percent: 95 }, /between 1 and 90/],
    [{ kind: 'purchase_discount', amountUsd: 0.1 }, /amount off/],
    [{ kind: 'credits' }, /credits must be/],
    [{ kind: 'credits', credits: -5 }, /credits must be/],
    [{ kind: 'ebay_accounts', ebayAccounts: 0 }, /eBay accounts/],
    [{ kind: 'free_plan' }, /Choose the plan/],
    [{ kind: 'free_plan', planId: 'd'.repeat(24) }, /does not exist/],
    [{ kind: 'credits', credits: 5, expiresInDays: 0 }, /Days until it expires/],
  ];
  for (const [input, re] of bad) await assert.rejects(() => give(U1, input), (e) => e.statusCode === 400 && re.test(e.message), JSON.stringify(input));
  assert.strictEqual(db.vouchers.length, 0, 'nothing was created by a refused input');

  // ---------- admin routes ----------
  let res = await call(adminRoutes, 'post', '/', { userId: ADMIN, body: { kind: 'credits', credits: 100 } });
  assert.strictEqual(res.statusCode, 400, 'no user chosen');
  res = await call(adminRoutes, 'post', '/', { userId: ADMIN, body: { userId: '7'.repeat(24), kind: 'credits', credits: 100 } });
  assert.strictEqual(res.statusCode, 404);
  res = await call(adminRoutes, 'post', '/', { userId: ADMIN, body: { userId: U1, kind: 'credits', credits: 100, note: 'Welcome gift', expiresInDays: 30 } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.voucher.description, '100 free credits');
  assert.strictEqual(res.body.voucher.user, 'buyer@x.com');
  assert.strictEqual(db.mails.length, 1, 'the user is told by email');
  assert.strictEqual(db.mails[0].redeem, true);
  res = await call(adminRoutes, 'post', '/', { userId: ADMIN, body: { userId: U1, kind: 'purchase_discount', percent: 25, planId: STARTER.id } });
  assert.strictEqual(res.body.voucher.description, '25% off the Starter plan');
  assert.strictEqual(db.mails[1].redeem, false, 'a discount is chosen at checkout, not redeemed');
  res = await call(adminRoutes, 'get', '/users', { query: { q: 'buyer' } });
  assert.deepStrictEqual(res.body.users.map((u) => u.email), ['buyer@x.com']);
  res = await call(adminRoutes, 'get', '/', { query: { q: 'buyer' } });
  assert.strictEqual(res.body.vouchers.length, 2);
  assert.strictEqual(res.body.counts.active, 2);
  const toRevoke = res.body.vouchers[0].id;
  res = await call(adminRoutes, 'post', '/:id/revoke', { params: { id: toRevoke } });
  assert.strictEqual(res.body.voucher.state, 'revoked');
  res = await call(adminRoutes, 'post', '/:id/revoke', { params: { id: toRevoke } });
  assert.strictEqual(res.statusCode, 409, 'a revoked voucher cannot be taken back again');
  res = await call(adminRoutes, 'post', '/:id/revoke', { params: { id: 'zzz' } });
  assert.strictEqual(res.statusCode, 404);

  // ---------- redeeming: credits, eBay accounts, a free plan ----------
  reset();
  const vc = await give(U1, { kind: 'credits', credits: 250 });
  res = await call(userRoutes, 'get', '/', {});
  assert.strictEqual(res.body.activeCount, 1);
  assert.strictEqual(res.body.vouchers[0].state, 'active');
  assert.strictEqual(res.body.vouchers[0].redeemable, true);
  res = await call(userRoutes, 'post', '/:id/redeem', { userId: U2, params: { id: vc.id } });
  assert.strictEqual(res.statusCode, 404, 'someone else cannot use it');
  assert.strictEqual(db.credits[U2], undefined);
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vc.id } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db.credits[U1], 250);
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vc.id } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /already used/);
  assert.strictEqual(db.credits[U1], 250, 'it works once');
  // two presses at the same moment: one wins
  const vr = await give(U1, { kind: 'credits', credits: 10 });
  const both = await Promise.all([call(userRoutes, 'post', '/:id/redeem', { params: { id: vr.id } }), call(userRoutes, 'post', '/:id/redeem', { params: { id: vr.id } })]);
  assert.strictEqual(both.filter((r) => r.body.success).length, 1);
  assert.strictEqual(db.credits[U1], 260);

  const ve = await give(U1, { kind: 'ebay_accounts', ebayAccounts: 2 });
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: ve.id } });
  assert.strictEqual(db.slots[U1], 2);
  assert.match(res.body.message, /2 more eBay accounts/);

  const vp = await give(U1, { kind: 'free_plan', planId: GROWTH.id });
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vp.id } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.planName, 'Growth');
  assert.strictEqual(db.credits[U1], 260 + 1500);
  assert.strictEqual(db.purchases.length, 1);
  assert.strictEqual(db.purchases[0].provider, 'voucher');
  assert.strictEqual(db.purchases[0].priceUsd, 0);
  assert.strictEqual(db.receipts.length, 0, 'a free plan sends no receipt');
  assert.strictEqual(db.alerts.length, 0, 'and no "new payment" alert');

  // expired / discount vouchers are not redeemed; a failed redeem gives the voucher back
  const vx = await give(U1, { kind: 'credits', credits: 5, expiresInDays: 1 });
  db.vouchers.find((v) => v.id === vx.id).expiresAt = new Date(Date.now() - 1000);
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vx.id } });
  assert.match(res.body.error, /expired/);
  res = await call(userRoutes, 'get', '/', {});
  assert.strictEqual(res.body.vouchers.find((v) => v.id === vx.id).state, 'expired');
  const vd = await give(U1, { kind: 'purchase_discount', percent: 10 });
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vd.id } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /Buy credits/);
  const vf = await give(U1, { kind: 'credits', credits: 7 });
  db.failCredits = true;
  res = await call(userRoutes, 'post', '/:id/redeem', { params: { id: vf.id } });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.vouchers.find((v) => v.id === vf.id).status, 'active', 'given back when the credits could not be added');
  db.failCredits = false;

  // ---------- checkout with a voucher ----------
  reset();
  const v20 = await give(U1, { kind: 'purchase_discount', percent: 20 });
  const vStarterOnly = await give(U1, { kind: 'purchase_discount', amountUsd: 4, planId: STARTER.id });
  const vOther = await give(U2, { kind: 'purchase_discount', percent: 50 });
  res = await call(paymentRoutes, 'get', '/plans', { query: { voucherId: v20.id } });
  assert.deepStrictEqual(res.body.plans.map((p) => p.discountedPriceUsd), [8, 20]);
  assert.strictEqual(res.body.voucher.description, '20% off any credit plan');
  assert.strictEqual(res.body.referralDiscount, null);
  res = await call(paymentRoutes, 'get', '/plans', { query: { voucherId: vStarterOnly.id } });
  assert.deepStrictEqual(res.body.plans.map((p) => p.discountedPriceUsd), [6, undefined]);
  assert.strictEqual(res.body.plans[1].voucherNotValid, true, 'a voucher for one plan does not apply to another');
  res = await call(paymentRoutes, 'get', '/plans', { query: { voucherId: vOther.id } });
  assert.strictEqual(res.statusCode, 404, 'someone else\'s voucher');

  res = await call(paymentRoutes, 'post', '/checkout', { body: { planId: STARTER.id, voucherId: v20.id } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.voucherApplied, true);
  assert.strictEqual(db.sessions[0].amount, 8);
  assert.strictEqual(db.sessions[0].metadata.elms_voucher_id, v20.id);
  res = await call(paymentRoutes, 'post', '/checkout', { body: { planId: GROWTH.id, voucherId: vStarterOnly.id } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /not valid for the Growth plan/);
  res = await call(paymentRoutes, 'post', '/checkout', { body: { planId: STARTER.id, voucherId: vOther.id } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.sessions.length, 1, 'no checkout was started for a voucher that cannot be used');
  // a voucher wins over the referral discount, which is not used up
  db.referral = { id: 'e'.repeat(24), referrerId: U2, referredUserId: U1, code: 'X', discountedPurchases: 0, purchases: 0, totalSpentUsd: 0, firstPurchaseAt: null, rewardedAt: null, rewardCredits: 0, createdAt: new Date() };
  db.users.set(U2, { email: 'other@x.com', name: 'Other', referralCode: 'X' });
  res = await call(paymentRoutes, 'post', '/checkout', { body: { planId: STARTER.id, voucherId: v20.id } });
  assert.strictEqual(db.sessions[1].amount, 8, 'the voucher, not the 10% referral price');
  assert.strictEqual(db.sessions[1].metadata.elms_referral_id, undefined);
  res = await call(paymentRoutes, 'post', '/checkout', { body: { planId: STARTER.id } });
  assert.strictEqual(db.sessions[2].amount, 9, 'without a voucher the referral discount applies as before');

  // ---------- the payment arrives ----------
  let out = await pay.grantForSession(paid(db.sessions[0]));
  assert.strictEqual(out.granted, true);
  assert.strictEqual(db.purchases[0].priceUsd, 8);
  assert.strictEqual(db.purchases[0].listPriceUsd, 10);
  assert.strictEqual(db.purchases[0].discountPercent, 20);
  assert.strictEqual(db.purchases[0].voucherId, v20.id);
  assert.strictEqual(db.purchases[0].referralId, null);
  assert.strictEqual(db.vouchers.find((v) => v.id === v20.id).status, 'used');
  assert.strictEqual(db.referral.discountedPurchases, 0, 'the referral discount is still there');
  // the same payment reported again: nothing changes
  out = await pay.grantForSession(paid(db.sessions[0]));
  assert.strictEqual(out.duplicate, true);
  // a second checkout made before the first was paid, paid after: the voucher is already used, the payment stands, the admin is told
  out = await pay.grantForSession(paid(db.sessions[1]));
  assert.strictEqual(out.granted, true, JSON.stringify(out));
  assert.strictEqual(db.alerts.some((a) => /voucher was used twice/i.test(a.subject)), true);

  // wrong amounts / foreign vouchers are not credited
  reset();
  const vv = await give(U1, { kind: 'purchase_discount', percent: 20 });
  const vo = await give(U2, { kind: 'purchase_discount', percent: 20 });
  await call(paymentRoutes, 'post', '/checkout', { body: { planId: STARTER.id, voucherId: vv.id } });
  out = await pay.grantForSession(paid(db.sessions[0], { amount: 5, amount_received: 5 }));
  assert.strictEqual(out.reason, 'amount_mismatch', '20% off $10 is $8, not $5');
  out = await pay.grantForSession(paid(db.sessions[0], { metadata: { ...db.sessions[0].metadata, elms_voucher_id: vo.id } }));
  assert.strictEqual(out.reason, 'amount_mismatch', 'another person\'s voucher does not give the price');
  out = await pay.grantForSession(paid(db.sessions[0], { metadata: { elms_user_id: U1, elms_plan_id: STARTER.id } }));
  assert.strictEqual(out.reason, 'amount_mismatch', 'the discounted amount without a voucher is not the list price');
  assert.strictEqual(db.purchases.length, 0);
  assert.strictEqual(db.vouchers.find((v) => v.id === vv.id).status, 'active', 'an unpaid checkout does not use the voucher');

  console.log('voucher: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
