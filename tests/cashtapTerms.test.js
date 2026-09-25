// Checkout and payment for a monthly / yearly plan and for the custom plan (CashTap).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
process.env.PAYMENT_PROVIDER = 'cashtap';

const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';
const plan = { id: PLAN_ID, name: 'Pro', priceUsd: 120, credits: 6000, maxEbayAccounts: 2, yearlyPriceUsd: 1200, active: true };
const noYearly = { id: '64b7f0c2a1b2c3d4e5f60719', name: 'Mini', priceUsd: 10, credits: 500, maxEbayAccounts: 1, yearlyPriceUsd: null, active: true };
const custom = { enabled: true, minUsd: 80, maxUsd: 2000, creditsPerUsd: 50, yearlyDiscountPercent: 10, includedStores: 1, extraStoreMonthlyUsd: 20, maxExtraStores: 20 };

const users = new Map([['u1', { email: 'b@x.com', creditBalance: 0, maxEbayAccounts: 1, planExpiresAt: null }]]);
const purchases = [];
let sessionArgs = null;
stub('models/plansModel', { getPlanById: async (id) => [plan, noYearly].find((p) => p.id === id) || null, listActivePlans: async () => [plan, noYearly] });
stub('models/purchasesModel', { recordPurchase: async (p) => { if (purchases.some((x) => x.providerTransactionId === p.providerTransactionId)) return null; purchases.push(p); return { ...p, id: 'p' + purchases.length }; }, listPurchasesForUser: async () => [], getPurchaseById: async () => null });
stub('models/usersModel', {
  addCredits: async (id, n) => { users.get(id).creditBalance += n; },
  getUserById: async (id) => (users.has(id) ? { id, name: 'Ali', ...users.get(id) } : null),
  setMaxEbayAccounts: async (id, n) => { users.get(id).maxEbayAccounts = n; },
});
stub('models/schemas/User', { updateOne: async ({ _id }, u) => { Object.assign(users.get(String(_id)), u.$set); return { modifiedCount: 1 }; }, findOne: () => ({ lean: async () => null }) });
stub('services/emailService', { sendAdminAlert: async () => {}, sendPurchaseReceiptEmail: async () => {}, sendPlanEndedEmail: async () => {} });
stub('models/referralsModel', { findReferralByReferred: async () => null });
stub('models/settingsModel', { getCustomPlanSettings: async () => custom, getAffiliateSettings: async () => ({ enabled: false }), getReferralSettings: async () => ({ enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 }) });
stub('services/cashtapService', {
  isConfigured: () => true,
  createSession: async (a) => { sessionArgs = a; return { id: 'cs_live_' + purchases.length + 'AAAAAAAAAAAAAAAAAAAA', url: 'https://checkout.cashtap.cash/pay/x' }; },
});
stub('middleware/requireAuth', { requireAuth: (q, s, n) => n() });
stub('services/paddleService', { createTransaction: async () => ({}) });
stub('services/referralService', { discountFor: async () => null, priceAfterDiscount: (p, pc) => Math.round(p * (100 - pc)) / 100, clampPercent: (x) => Number(x) || 0, afterPurchase: async () => {} });
stub('services/voucherService', { usableForPurchase: async () => { throw new Error('no vouchers here'); }, appliesToPlan: () => false, priceWith: (p) => p, markUsedForPurchase: async () => true });

const router = require('../routes/payments');
const pay = require('../services/cashtapPaymentService');
const checkout = handler(router, 'post', '/checkout');
const post = async (body) => { const res = fakeRes(); await checkout({ userId: 'u1', body }, res); return res; };
const paidFrom = (args, over = {}) => ({ id: 'cs_paid_' + Math.random().toString(36).slice(2, 12), status: 'completed', amount: args.amount, amount_received: args.amount, metadata: args.metadata, ...over });

(async () => {
  // standard plan, yearly: the price comes from the plan's yearly price, credits x12
  let res = await post({ planId: PLAN_ID, billing: 'yearly' });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(sessionArgs.amount, 1200);
  assert.strictEqual(sessionArgs.metadata.elms_billing, 'yearly');
  assert.ok(/72,000 credits, valid for 1 year/.test(sessionArgs.lineItems[0].description));
  let out = await pay.grantForSession(paidFrom(sessionArgs));
  assert.strictEqual(out.granted, true);
  assert.strictEqual(users.get('u1').creditBalance, 72000);
  assert.ok(users.get('u1').planExpiresAt > new Date(Date.now() + 360 * 86400000));
  assert.strictEqual(purchases.at(-1).planName, 'Pro (yearly)');

  // yearly on a plan without a yearly price is refused
  res = await post({ planId: noYearly.id, billing: 'yearly' });
  assert.strictEqual(res.statusCode, 400);
  // monthly (or nothing) is the plan's own price
  res = await post({ planId: PLAN_ID });
  assert.strictEqual(sessionArgs.amount, 120);
  assert.strictEqual(sessionArgs.metadata.elms_billing, 'monthly');

  // the custom plan: worked out here from the buyer's choices
  res = await post({ custom: { amountUsd: 120, extraStores: 2 }, billing: 'monthly' });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(sessionArgs.amount, 160);
  assert.strictEqual(sessionArgs.metadata.elms_plan_id, 'custom');
  assert.strictEqual(sessionArgs.metadata.elms_credits, '6000');
  assert.strictEqual(sessionArgs.metadata.elms_stores, '3');
  const monthlyCustom = sessionArgs;
  users.get('u1').creditBalance = 0;
  out = await pay.grantForSession(paidFrom(monthlyCustom));
  assert.strictEqual(out.granted, true);
  assert.strictEqual(users.get('u1').creditBalance, 6000);
  assert.strictEqual(users.get('u1').maxEbayAccounts, 3);
  assert.strictEqual(purchases.at(-1).planId, null);
  assert.strictEqual(purchases.at(-1).termMonths, 1);

  // out of range / wrong choices never reach CashTap
  const before = sessionArgs;
  for (const bad of [{ amountUsd: 50 }, { amountUsd: 5000 }, { amountUsd: 120.5 }, { amountUsd: 120, extraStores: 99 }]) {
    res = await post({ custom: bad });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.strictEqual(sessionArgs, before, 'no session was made for a bad choice');
  res = await post({ custom: { amountUsd: 100 }, voucherId: 'v1' });
  assert.strictEqual(res.statusCode, 400, 'no voucher on the custom plan');

  // a paid session for the custom plan whose amount is not what we asked is refused
  res = await post({ custom: { amountUsd: 200 }, billing: 'yearly' });
  const yearlyCustom = sessionArgs;
  assert.strictEqual(yearlyCustom.amount, 2160);
  out = await pay.grantForSession(paidFrom(yearlyCustom, { amount: 1000, amount_received: 1000 }));
  assert.strictEqual(out.reason, 'amount_mismatch');

  // an old session (no term in it) is still a one-time pack with no end date
  users.set('u2', { email: 'c@x.com', creditBalance: 0, maxEbayAccounts: 1, planExpiresAt: null });
  out = await pay.grantForSession({ id: 'cs_old_AAAAAAAAAAAAAAAAAAAA', status: 'completed', amount: 10, amount_received: 10, metadata: { elms_user_id: 'u2', elms_plan_id: noYearly.id } });
  assert.strictEqual(out.granted, true);
  assert.strictEqual(users.get('u2').planExpiresAt, null);

  // the quote the page shows is the same as the checkout
  const quote = handler(router, 'get', '/custom-quote');
  res = fakeRes(); await quote({ userId: 'u1', query: { amountUsd: '200', billing: 'yearly', extraStores: '0' } }, res);
  assert.strictEqual(res.body.offer.priceUsd, 2160);
  assert.strictEqual(res.body.offer.credits, 120000);
  res = fakeRes(); await quote({ userId: 'u1', query: { amountUsd: '10' } }, res);
  assert.strictEqual(res.statusCode, 400);

  // the plans list tells the page about yearly, the custom plan and the plan the user has now
  const plansRoute = handler(router, 'get', '/plans');
  res = fakeRes(); await plansRoute({ userId: 'u1', query: {} }, res);
  assert.strictEqual(res.body.plans.find((p) => p.id === PLAN_ID).yearlyPriceUsd, 1200);
  assert.strictEqual(res.body.custom.maxUsd, 2000);
  assert.ok(res.body.myPlan && res.body.myPlan.expiresAt);

  console.log('cashtapTerms tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
