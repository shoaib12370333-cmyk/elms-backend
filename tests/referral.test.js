// Referral programme: codes, the friend's discount (server-side, limited uses / days, per-referrer override), the checkout amount and
// its check when the payment arrives, the referrer's reward (once), the sign-up hooks, the public/user/admin routes.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const realGuard = require('../services/signupBonusGuard');
const { emailKey } = realGuard;

// ---------- in-memory stand-ins for the database ----------
const db = { users: new Map(), referrals: [], purchases: [], credits: {}, alerts: [], sessions: [], seq: 0 };
const hex = () => String(++db.seq).padStart(24, 'a'); // a 24-character id, like an ObjectId
const addUser = (id, email, extra = {}) => db.users.set(id, { id, email, emailKey: emailKey(email), username: null, name: null, referralCode: null, referralDiscountPercent: null, referralRewardCredits: null, referralBlocked: false, suspended: false, createdAt: new Date(), ...extra });
const cfg = { enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 };

stub('models/settingsModel', {
  getCustomPlanSettings: async () => ({ enabled: false }),
  getAffiliateSettings: async () => ({ enabled: false }),
  getReferralSettings: async () => ({ ...cfg }),
  updateReferralSettings: async (i) => { Object.assign(cfg, i); return { ...cfg }; },
  getSettings: async () => ({}),
});
const dupe = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
const referralsModel = {
  getUser: async (id) => db.users.get(String(id)) || null,
  findUserByCode: async (code) => [...db.users.values()].find((u) => u.referralCode === code) || null,
  setCodeIfMissing: async (id, code) => {
    const u = db.users.get(String(id)); if (!u) return null;
    if (u.referralCode) return u.referralCode;
    if ([...db.users.values()].some((x) => x.referralCode === code)) throw dupe();
    u.referralCode = code; return code;
  },
  replaceCode: async (id, code) => {
    if ([...db.users.values()].some((x) => x.referralCode === code && x.id !== id)) throw dupe();
    db.users.get(id).referralCode = code; return db.users.get(id);
  },
  setReferrerOverrides: async (id, o) => {
    const u = db.users.get(id);
    if (o.discountPercent !== undefined) u.referralDiscountPercent = o.discountPercent;
    if (o.rewardCredits !== undefined) u.referralRewardCredits = o.rewardCredits;
    if (o.blocked !== undefined) u.referralBlocked = !!o.blocked;
    return u;
  },
  searchUsers: async (q) => [...db.users.values()].filter((u) => u.email.includes(String(q).toLowerCase())).slice(0, 8),
  getUsersByIds: async (ids) => new Map(ids.filter((i) => db.users.has(String(i))).map((i) => [String(i), db.users.get(String(i))])),
  findReferralByReferred: async (id) => db.referrals.find((r) => r.referredUserId === String(id)) || null,
  createReferral: async ({ referrerId, referredUserId, code, ip }) => {
    if (db.referrals.some((r) => r.referredUserId === String(referredUserId))) throw dupe();
    const r = { id: hex(), referrerId: String(referrerId), referredUserId: String(referredUserId), code, ip, discountedPurchases: 0, purchases: 0, totalSpentUsd: 0, firstPurchaseAt: null, rewardedAt: null, rewardCredits: 0, createdAt: new Date() };
    db.referrals.push(r); return r;
  },
  incDiscounted: async (id) => { db.referrals.find((r) => r.id === id).discountedPurchases++; },
  recordPurchaseOn: async (id, price) => { const r = db.referrals.find((x) => x.id === id); r.purchases++; r.totalSpentUsd += price; r.firstPurchaseAt = r.firstPurchaseAt || new Date(); },
  claimReward: async (id, credits) => { const r = db.referrals.find((x) => x.id === id); if (r.rewardedAt) return null; r.rewardedAt = new Date(); r.rewardCredits = credits; return r; },
  referrerTotals: async (id) => {
    const mine = db.referrals.filter((r) => r.referrerId === String(id));
    return { signups: mine.length, buyers: mine.filter((r) => r.firstPurchaseAt).length, creditsEarned: mine.reduce((s, r) => s + r.rewardCredits, 0), revenueUsd: mine.reduce((s, r) => s + r.totalSpentUsd, 0) };
  },
  listForReferrer: async (id) => db.referrals.filter((r) => r.referrerId === String(id)),
  adminTotals: async () => ({ signups: db.referrals.length, buyers: 0, revenueUsd: 0, creditsGiven: 0, discountedPurchases: 0, discountUsd: 0 }),
  topReferrers: async () => [...new Set(db.referrals.map((r) => r.referrerId))].map((id) => ({ referrerId: id, signups: db.referrals.filter((r) => r.referrerId === id).length, buyers: 0, revenueUsd: 0, creditsEarned: 0, lastAt: new Date() })),
  recentReferrals: async () => db.referrals,
};
stub('models/referralsModel', referralsModel);
const { fakeUsers } = require('./helpers/fakeUsers');
stub('models/usersModel', {
  addCredits: async (id, n) => { db.credits[id] = (db.credits[id] || 0) + n; },
  getUserById: async (id) => (db.users.has(id) ? { id, ...db.users.get(id) } : null),
  setMaxEbayAccounts: async () => {},
  findOrCreateUser: async (p) => { const id = 'g' + (++db.seq); addUser(id, p.email); return { id, email: p.email }; },
  registerWithPassword: async ({ email }) => { const id = 'r' + (++db.seq); addUser(id, email); return { id, email }; },
  loginWithPassword: async () => null, getSettings: async () => ({}), setOrderSyncSettings: async () => null,
  getOrCreateExtensionKey: async () => null, regenerateExtensionKey: async () => null, getUserByExtensionKey: async () => null,
});
let bought = false;
const plan = { id: 'plan1', name: 'Starter', priceUsd: 10, credits: 500, maxEbayAccounts: 1, active: true };
stub('models/plansModel', { getPlanById: async (id) => (id === 'plan1' ? plan : null), listActivePlans: async () => [plan, { id: 'plan2', name: 'Tiny', priceUsd: 0.5, credits: 10, active: true }] });
stub('models/purchasesModel', {
  recordPurchase: async (p) => { if (db.purchases.some((x) => x.providerTransactionId === p.providerTransactionId)) return null; db.purchases.push(p); bought = true; return p; },
  purchaseExists: async (tx) => db.purchases.some((x) => x.providerTransactionId === tx),
  getByTransactionId: async (tx) => db.purchases.find((x) => x.providerTransactionId === tx) || null,
  hasPurchases: async () => bought,
  listPurchasesForUser: async () => [],
});
stub('models/schemas/User', fakeUsers(db.users));
stub('services/emailService', { sendAdminAlert: async (m) => { db.alerts.push(m); }, sendPurchaseReceiptEmail: async () => {} });
const sessions = [];
stub('services/cashtapService', { createSession: async (s) => { sessions.push(s); return { id: 'cs_live_' + String(sessions.length).padStart(22, 'A'), url: 'https://pay.cashtap.cash/x', amount: s.amount }; }, isConfigured: () => true });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next() });
stub('services/sessionTracker', { requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {} });
stub('services/sessionService', { issueSessionToken: () => 'token' });
stub('services/googleAuthService', { verifyGoogleToken: async () => ({ email: 'gnew@x.com', googleId: 'gid', name: 'G' }) });
stub('services/accessGuard', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });
stub('services/signupBonusGuard', { ...realGuard, welcomeBonusDecision: async () => ({ allowed: true }) });
stub('services/emailQualityService', { checkEmailQuality: async () => ({ ok: true }) }); // no DNS in tests
// The confirmation-code sign-up has its own test (signupConfirm.test.js). Here a start remembers the codes typed at sign-up and
// confirming makes the account, so the referral hooks of the routes can be checked.
const pendingSignups = new Map();
stub('services/signupConfirmService', {
  startSignup: async ({ email, referralCode }) => { const t = 'tok' + (pendingSignups.size + 1); pendingSignups.set(t, { email, referralCode }); return { pendingToken: t, email, codeMinutes: 15, resendAfterSeconds: 60 }; },
  confirmSignup: async ({ pendingToken }) => { const p = pendingSignups.get(pendingToken); const id = 'r' + (++db.seq); addUser(id, p.email); return { user: { id, email: p.email }, referralCode: p.referralCode, affiliateCode: null }; },
  resendCode: async () => ({}),
});
stub('services/passwordService', { hashPassword: async (p) => 'hash:' + p, verifyPassword: async () => true });

const referrals = require('../services/referralService');
const pay = require('../services/cashtapPaymentService');
const referralRoutes = require('../routes/referrals');
const adminRoutes = require('../routes/adminReferrals');
const paymentRoutes = require('../routes/payments');
const authRoutes = require('../routes/auth');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = () => r; return r; };
const call = async (router, method, p, req) => { const res = fakeRes(); await handler(router, method, p)({ userId: 'friend', body: {}, query: {}, headers: {}, ...req }, res); return res; };
const reset = () => {
  db.users.clear(); db.referrals.length = 0; db.purchases.length = 0; db.credits = {}; db.alerts.length = 0; sessions.length = 0; bought = false;
  Object.assign(cfg, { enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 });
  addUser('boss', 'boss@gmail.com', { referralCode: 'BOSS2024' });
  addUser('friend', 'friend@x.com');
};
const paid = (session, over = {}) => ({ id: session.id, status: 'completed', amount: session.amount, amount_received: session.amount, metadata: session.metadata, ...over });

(async () => {
  // ---------- small pure pieces ----------
  assert.strictEqual(referrals.normalizeCode(' bo-ss 2024 '), 'BOSS2024');
  assert.strictEqual(referrals.normalizeCode('<script>'), '');
  assert.strictEqual(referrals.normalizeCode(null), '');
  assert.strictEqual(referrals.priceAfterDiscount(10, 10), 9);
  assert.strictEqual(referrals.priceAfterDiscount(19.99, 15), 16.99);
  assert.strictEqual(referrals.priceAfterDiscount(0.5, 50), 0.5, 'never below the payment minimum of $0.50');
  assert.strictEqual(referrals.priceAfterDiscount(1, 90), 0.5);
  assert.strictEqual(referrals.priceAfterDiscount(10, 0), 10);
  assert.strictEqual(referrals.priceAfterDiscount(10, 500), 1, 'a silly percent is capped at 90');
  assert.strictEqual(referrals.clampPercent(-5), 0);
  assert.strictEqual(referrals.clampPercent('abc'), 0);
  assert.strictEqual(referrals.maskEmail('bilal@gmail.com'), 'b***l@gmail.com');
  assert.strictEqual(referrals.maskEmail('ab@x.com'), 'a@x.com');
  for (let i = 0; i < 200; i++) assert.match(referrals.randomCode(), /^[A-HJ-NP-Z2-9]{8}$/);

  // ---------- codes ----------
  reset();
  const code = await referrals.ensureCode('friend');
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.strictEqual(await referrals.ensureCode('friend'), code, 'the same code every time');
  assert.strictEqual((await referrals.checkCode(code.toLowerCase())).valid, true, 'typed in lower case');
  assert.strictEqual((await referrals.checkCode('NOPE1234')).valid, false);
  assert.strictEqual((await referrals.checkCode('')).valid, false);
  cfg.enabled = false;
  assert.deepStrictEqual(await referrals.checkCode('BOSS2024'), { valid: false, reason: 'disabled' });
  cfg.enabled = true;
  await assert.rejects(() => referrals.setCustomCode('friend', 'a b'), (e) => e.statusCode === 400);
  await assert.rejects(() => referrals.setCustomCode('friend', 'BOSS2024'), (e) => e.statusCode === 409, 'a taken code is refused');
  assert.strictEqual((await referrals.setCustomCode('friend', 'bilal-20')).referralCode, 'BILAL20');

  // ---------- sign-up: attaching ----------
  reset();
  addUser('newbie', 'newbie@x.com');
  let r = await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'boss2024', ip: '9.9.9.9' });
  assert.deepStrictEqual(r, { applied: true, discountPercent: 10, discountUses: 1, discountDays: 0 });
  assert.strictEqual(db.referrals.length, 1);
  assert.strictEqual(db.referrals[0].referrerId, 'boss');
  r = await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  assert.strictEqual(r.reason, 'already', 'a person is referred once');
  assert.strictEqual(db.referrals.length, 1);
  addUser('other', 'other@x.com');
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'other', email: 'o@x.com' }, code: 'ZZZZ9999' })).reason, 'invalid_code');
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'boss', email: 'boss@gmail.com' }, code: 'BOSS2024' })).reason, 'self');
  // the same mailbox written another way (dots / +tag) is still the referrer
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'sock', email: 'b.o.s.s+2@gmail.com' }, code: 'BOSS2024' })).reason, 'self');
  db.users.get('boss').referralBlocked = true;
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'other', email: 'other@x.com' }, code: 'BOSS2024' })).reason, 'invalid_code', 'a blocked code does not work');
  db.users.get('boss').referralBlocked = false;
  cfg.enabled = false;
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'other', email: 'other@x.com' }, code: 'BOSS2024' })).reason, 'disabled');
  cfg.enabled = true;

  // ---------- the discount ----------
  let d = await referrals.discountFor('newbie');
  assert.strictEqual(d.percent, 10);
  assert.strictEqual(d.usesLeft, 1);
  assert.strictEqual(await referrals.discountFor('nobody-referred-me'), null);
  db.users.get('boss').referralDiscountPercent = 25; // the admin gave this referrer a bigger offer
  assert.strictEqual((await referrals.discountFor('newbie')).percent, 25);
  db.users.get('boss').referralDiscountPercent = 0;
  assert.strictEqual(await referrals.discountFor('newbie'), null, '0% means no discount');
  db.users.get('boss').referralDiscountPercent = null;
  db.users.get('boss').suspended = true;
  assert.strictEqual(await referrals.discountFor('newbie'), null, 'a suspended referrer gives nothing');
  db.users.get('boss').suspended = false;
  cfg.discountDays = 7;
  db.referrals[0].createdAt = new Date(Date.now() - 8 * 86400000);
  assert.strictEqual(await referrals.discountFor('newbie'), null, 'expired after the admin\'s number of days');
  db.referrals[0].createdAt = new Date(Date.now() - 6 * 86400000);
  assert.ok(await referrals.discountFor('newbie'), 'still valid on day 6');
  cfg.discountDays = 0;
  cfg.enabled = false;
  assert.strictEqual(await referrals.discountFor('newbie'), null, 'switched off');
  cfg.enabled = true;

  // ---------- checkout: the amount is discounted on the server; the payment is checked against it ----------
  reset();
  addUser('newbie', 'newbie@x.com');
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  let res = await call(paymentRoutes, 'post', '/checkout', { userId: 'newbie', body: { planId: 'plan1' } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.discountPercent, 10);
  assert.strictEqual(sessions[0].amount, 9, 'the friend is asked for $9, not $10');
  assert.strictEqual(sessions[0].lineItems[0].unit_amount, 9);
  assert.strictEqual(sessions[0].metadata.elms_discount_percent, '10');
  assert.match(sessions[0].metadata.elms_referral_id, /^[a-f0-9]{24}$/);
  // someone with no referral pays the list price
  res = await call(paymentRoutes, 'post', '/checkout', { userId: 'boss', body: { planId: 'plan1' } });
  assert.strictEqual(sessions[1].amount, 10);
  assert.strictEqual(sessions[1].metadata.elms_discount_percent, undefined);

  // the plans list shows the discounted prices
  res = await call(paymentRoutes, 'get', '/plans', { userId: 'newbie' });
  assert.deepStrictEqual(res.body.plans.map((p) => p.discountedPriceUsd), [9, 0.5]);
  assert.strictEqual(res.body.referralDiscount.percent, 10);
  res = await call(paymentRoutes, 'get', '/plans', { userId: 'boss' });
  assert.strictEqual(res.body.plans[0].discountedPriceUsd, undefined);
  assert.strictEqual(res.body.referralDiscount, null);

  // paying: the discounted amount is accepted, credits given, the discount counted
  let out = await pay.grantForSession(paid(sessions[0]));
  assert.strictEqual(out.granted, true);
  assert.strictEqual(db.purchases[0].priceUsd, 9);
  assert.strictEqual(db.purchases[0].listPriceUsd, 10);
  assert.strictEqual(db.purchases[0].discountPercent, 10);
  assert.strictEqual(db.referrals[0].discountedPurchases, 1);
  assert.strictEqual(db.referrals[0].purchases, 1);
  assert.match(db.alerts[0].lines.join(' '), /10% referral discount/);
  // reported again (webhook retry): nothing is counted twice
  out = await pay.grantForSession(paid(sessions[0]));
  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(db.referrals[0].discountedPurchases, 1);
  assert.strictEqual(db.referrals[0].purchases, 1);
  // the one discounted purchase is used: the next checkout is the full price
  assert.strictEqual(await referrals.discountFor('newbie'), null);
  await call(paymentRoutes, 'post', '/checkout', { userId: 'newbie', body: { planId: 'plan1' } });
  assert.strictEqual(sessions[2].amount, 10);
  res = await call(paymentRoutes, 'get', '/plans', { userId: 'newbie' });
  assert.strictEqual(res.body.referralDiscount, null);

  // a payment whose amount does not fit what the session claims is not credited
  reset(); addUser('newbie', 'newbie@x.com');
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  await call(paymentRoutes, 'post', '/checkout', { userId: 'newbie', body: { planId: 'plan1' } });
  const forged = paid(sessions[0], { amount: 5, amount_received: 5 });
  out = await pay.grantForSession(forged);
  assert.strictEqual(out.reason, 'amount_mismatch', '10% off $10 is $9, not $5');
  assert.strictEqual(db.purchases.length, 0);
  const noPercent = paid(sessions[0], { metadata: { elms_user_id: 'newbie', elms_plan_id: 'plan1' } });
  out = await pay.grantForSession(noPercent);
  assert.strictEqual(out.reason, 'amount_mismatch', '$9 with no discount recorded does not match the $10 list price');
  const junkId = paid(sessions[0], { metadata: { ...sessions[0].metadata, elms_referral_id: 'not-an-id' } });
  out = await pay.grantForSession(junkId);
  assert.strictEqual(out.reason, 'amount_mismatch', 'a discount without a valid referral id is ignored');

  // ---------- the referrer's reward: once, for the first purchase ----------
  reset(); addUser('newbie', 'newbie@x.com');
  cfg.rewardCredits = 50;
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  await call(paymentRoutes, 'post', '/checkout', { userId: 'newbie', body: { planId: 'plan1' } });
  await pay.grantForSession(paid(sessions[0]));
  assert.strictEqual(db.credits.boss, 50, 'the referrer got the reward');
  assert.strictEqual(db.referrals[0].rewardCredits, 50);
  await call(paymentRoutes, 'post', '/checkout', { userId: 'newbie', body: { planId: 'plan1' } });
  await pay.grantForSession(paid(sessions[1]));
  assert.strictEqual(db.credits.boss, 50, 'no second reward for the same friend');
  // two purchases racing: only one claims the reward
  reset(); addUser('newbie', 'newbie@x.com'); cfg.rewardCredits = 20;
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  await Promise.all([referrals.afterPurchase({ userId: 'newbie', priceUsd: 9, referralId: null }), referrals.afterPurchase({ userId: 'newbie', priceUsd: 9, referralId: null })]);
  assert.strictEqual(db.credits.boss, 20);
  // a referrer with an own reward amount
  reset(); addUser('newbie', 'newbie@x.com'); cfg.rewardCredits = 20; db.users.get('boss').referralRewardCredits = 200;
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  await referrals.afterPurchase({ userId: 'newbie', priceUsd: 9, referralId: null });
  assert.strictEqual(db.credits.boss, 200);
  // blocked referrer: nothing given
  reset(); addUser('newbie', 'newbie@x.com'); cfg.rewardCredits = 20;
  await referrals.attachReferral({ user: { id: 'newbie', email: 'newbie@x.com' }, code: 'BOSS2024' });
  db.users.get('boss').referralBlocked = true;
  assert.strictEqual((await referrals.afterPurchase({ userId: 'newbie', priceUsd: 9, referralId: null })).rewarded, false);
  assert.strictEqual(db.credits.boss, undefined);
  // someone who was never referred: nothing happens, and it never throws
  assert.deepStrictEqual(await referrals.afterPurchase({ userId: 'boss', priceUsd: 9, referralId: null }), { rewarded: false });

  // ---------- the routes ----------
  reset();
  res = await call(referralRoutes, 'get', '/check', { query: { code: 'boss2024' } });
  assert.deepStrictEqual([res.body.valid, res.body.discountPercent], [true, 10]);
  res = await call(referralRoutes, 'get', '/check', { query: { code: 'WRONG' } });
  assert.strictEqual(res.body.valid, false);
  assert.match(res.body.message, /not valid/);

  res = await call(referralRoutes, 'get', '/me', { userId: 'friend' });
  assert.strictEqual(res.body.success, true);
  assert.match(res.body.code, /^[A-Z0-9]{8}$/);
  assert.strictEqual(res.body.link, 'https://elmstool.com/signup?ref=' + res.body.code);
  assert.strictEqual(res.body.offer.friendDiscountPercent, 10);
  assert.strictEqual(res.body.canAddCode, undefined, 'a code is used at sign-up only: there is nothing to add later');
  assert.strictEqual(res.body.referredBy, null);
  assert.ok(!referralRoutes.stack.some((l) => l.route && l.route.path === '/apply'), 'there is no route to add a code to an existing account');

  // a person referred at sign-up: their page shows the discount that is left
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'friend', email: 'friend@x.com' }, code: 'BOSS2024' })).applied, true);
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'friend', email: 'friend@x.com' }, code: 'BOSS2024' })).reason, 'already', 'a code is used once per person');
  res = await call(referralRoutes, 'get', '/me', { userId: 'friend' });
  assert.strictEqual(res.body.referredBy.code, 'BOSS2024');
  assert.strictEqual(res.body.referredBy.discount.percent, 10);
  // someone who has referred people cannot be referred themselves (they would need another person's code)
  addUser('third', 'third@x.com', { referralCode: 'THIRD222' });
  assert.strictEqual((await referrals.attachReferral({ user: { id: 'boss', email: 'boss@gmail.com' }, code: 'THIRD222' })).reason, 'referrer');
  // the referrer sees the friend, masked
  res = await call(referralRoutes, 'get', '/me', { userId: 'boss' });
  assert.strictEqual(res.body.stats.signups, 1);
  assert.strictEqual(res.body.referrals[0].who, 'f***d@x.com');
  assert.strictEqual(res.body.referrals[0].status, 'signed_up');

  // ---------- sign-up hooks ----------
  reset();
  // a password sign-up takes its code when the account is made, i.e. when the confirmation code is entered
  const signUp = async (body) => {
    const started = await call(authRoutes, 'post', '/register', { body });
    assert.strictEqual(started.body.needsConfirmation, true);
    return call(authRoutes, 'post', '/register/confirm', { body: { pendingToken: started.body.pendingToken, code: '123456' } });
  };
  res = await call(authRoutes, 'post', '/register', { body: { username: 'newuser', email: 'New@X.com', password: 'longenough', referralCode: 'boss2024' } });
  assert.strictEqual(res.body.needsConfirmation, true);
  assert.strictEqual(db.referrals.length, 0, 'nobody is referred before the address is confirmed');
  res = await call(authRoutes, 'post', '/register/confirm', { body: { pendingToken: res.body.pendingToken, code: '123456' } });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.referral, { applied: true, discountPercent: 10, discountUses: 1, discountDays: 0 });
  assert.strictEqual(db.referrals.length, 1);
  res = await signUp({ username: 'nocode', email: 'nocode@x.com', password: 'longenough' });
  assert.strictEqual(res.body.referral, undefined, 'no code, no referral field');
  res = await signUp({ username: 'badcode', email: 'badcode@x.com', password: 'longenough', referralCode: 'WRONG123' });
  assert.strictEqual(res.body.success, true, 'a bad code never stops the sign-up');
  assert.strictEqual(res.body.referral.applied, false);
  assert.strictEqual(res.body.referral.reason, 'invalid_code');
  // (an address that already has an account is refused when the sign-up starts: see signupConfirm.test.js)
  // Google sign-up (a new address) takes the code too
  res = await call(authRoutes, 'post', '/google', { body: { credential: 'x', referralCode: 'BOSS2024' } });
  assert.strictEqual(res.body.referral.applied, true);
  assert.strictEqual(db.referrals.length, 2);

  // ---------- admin routes ----------
  reset();
  res = await call(adminRoutes, 'put', '/settings', { body: { discountPercent: 15, discountUses: 2 } });
  assert.strictEqual(res.body.settings.discountPercent, 15);
  res = await call(adminRoutes, 'put', '/users/:id', { params: { id: 'zzz' }, body: {} });
  assert.strictEqual(res.statusCode, 404, 'a malformed id');
  const bossId = '0'.repeat(24);
  addUser(bossId, 'vip@x.com');
  res = await call(adminRoutes, 'put', '/users/:id', { params: { id: bossId }, body: { discountPercent: 95 } });
  assert.strictEqual(res.statusCode, 400);
  res = await call(adminRoutes, 'put', '/users/:id', { params: { id: bossId }, body: { discountPercent: 30, rewardCredits: 75, code: 'vip30' } });
  assert.strictEqual(res.body.user.code, 'VIP30');
  assert.strictEqual(res.body.user.effectiveDiscountPercent, 30);
  assert.strictEqual(res.body.user.effectiveRewardCredits, 75);
  res = await call(adminRoutes, 'put', '/users/:id', { params: { id: bossId }, body: { discountPercent: null, rewardCredits: null, blocked: true } });
  assert.strictEqual(res.body.user.discountPercent, null);
  assert.strictEqual(res.body.user.effectiveDiscountPercent, 15, 'null goes back to the default (15% was just set above)');
  assert.strictEqual(res.body.user.blocked, true);
  res = await call(adminRoutes, 'put', '/users/:id', { params: { id: bossId }, body: { code: 'BOSS2024' } });
  assert.strictEqual(res.statusCode, 409, 'a taken custom code');
  res = await call(adminRoutes, 'get', '/lookup', { query: { q: 'vip' } });
  assert.strictEqual(res.body.users[0].code, 'VIP30');
  res = await call(adminRoutes, 'get', '/', {});
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.settings.discountUses, 2);

  console.log('referral: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
