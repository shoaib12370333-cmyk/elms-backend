// Monthly / yearly plans, the custom plan, and plans that end: prices and credits worked out by the server, terms stacking, credits ending.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const P = require('../services/planPricing');

// ---- standard plans: monthly is the plan's price, yearly exists only with a yearly price and gives 12 months of credits at once
const plan = { id: '64b7f0c2a1b2c3d4e5f60718', name: 'Pro', priceUsd: 120, credits: 6000, maxEbayAccounts: 2, yearlyPriceUsd: 1200, paddlePriceId: null };
let o = P.planOffer(plan, 'monthly');
assert.deepStrictEqual([o.priceUsd, o.credits, o.termMonths, o.name], [120, 6000, 1, 'Pro (monthly)']);
o = P.planOffer(plan, 'yearly');
assert.deepStrictEqual([o.priceUsd, o.credits, o.termMonths, o.name, o.maxEbayAccounts], [1200, 72000, 12, 'Pro (yearly)', 2]);
assert.throws(() => P.planOffer({ ...plan, yearlyPriceUsd: null }, 'yearly'), /no yearly option/);
assert.strictEqual(P.planOffer(plan, undefined).billing, 'monthly');

// ---- the custom plan: 120 USD = 6000 credits (50 per dollar), 80..2000, an extra store costs extra, a year is 12 months minus the discount
const s = { enabled: true, minUsd: 80, maxUsd: 2000, creditsPerUsd: 50, yearlyDiscountPercent: 10, includedStores: 1, extraStoreMonthlyUsd: 20, maxExtraStores: 20 };
let c = P.customOffer(s, { amountUsd: 120, billing: 'monthly', extraStores: 0 });
assert.deepStrictEqual([c.priceUsd, c.credits, c.maxEbayAccounts, c.termMonths, c.id], [120, 6000, 1, 1, 'custom']);
c = P.customOffer(s, { amountUsd: 120, billing: 'monthly', extraStores: 2 });
assert.deepStrictEqual([c.priceUsd, c.credits, c.maxEbayAccounts], [160, 6000, 3], 'stores add money, not credits');
assert.ok(c.name.includes('2 extra eBay stores'));
c = P.customOffer(s, { amountUsd: 120, billing: 'yearly', extraStores: 0 });
assert.deepStrictEqual([c.priceUsd, c.credits, c.termMonths], [1296, 72000, 12], '120 x 12 = 1440, less 10%');
c = P.customOffer(s, { amountUsd: 80, billing: 'yearly', extraStores: 1 });
assert.deepStrictEqual([c.priceUsd, c.credits, c.maxEbayAccounts], [1080, 48000, 2], '(80 + 20) x 12 = 1200, less 10%');
assert.strictEqual(P.customOffer(s, { amountUsd: 2000, billing: 'monthly' }).credits, 100000);
for (const bad of [79, 2001, 100.5, 'x', NaN, 0]) assert.throws(() => P.customOffer(s, { amountUsd: bad }), /between|whole dollar/, String(bad));
assert.throws(() => P.customOffer(s, { amountUsd: 100, extraStores: 21 }), /Extra eBay stores/);
assert.throws(() => P.customOffer(s, { amountUsd: 100, extraStores: 1.5 }), /Extra eBay stores/);
assert.throws(() => P.customOffer({ ...s, enabled: false }, { amountUsd: 100 }), /not available/);

// ---- settings the admin saves
assert.deepStrictEqual(P.normalizeCustomSettings({}), P.CUSTOM_DEFAULTS);
assert.strictEqual(P.normalizeCustomSettings({ creditsPerUsd: '55.555' }).creditsPerUsd, 55.56);
assert.throws(() => P.normalizeCustomSettings({ minUsd: 500, maxUsd: 100 }), /lowest amount/);
assert.throws(() => P.normalizeCustomSettings({ yearlyDiscountPercent: 95 }), /yearly discount/);
assert.throws(() => P.normalizeCustomSettings({ includedStores: 0 }), /Included eBay stores/);

// ---- the offer a paid session was for
const meta = { elms_plan_id: 'custom', elms_billing: 'yearly', elms_price: '1296', elms_credits: '72000', elms_stores: '1', elms_months: '12', elms_label: 'Custom plan (yearly)' };
let back = P.offerFromMetadata(meta, null);
assert.deepStrictEqual([back.priceUsd, back.credits, back.maxEbayAccounts, back.termMonths, back.custom], [1296, 72000, 1, 12, true]);
assert.strictEqual(P.offerFromMetadata({ ...meta, elms_months: '7' }, null), null, 'a term that is not 1 or 12 is refused');
assert.strictEqual(P.offerFromMetadata({ ...meta, elms_credits: '-5' }, null), null);
back = P.offerFromMetadata({ elms_plan_id: plan.id, elms_billing: 'yearly' }, plan);
assert.deepStrictEqual([back.priceUsd, back.credits, back.termMonths], [1200, 72000, 12]);
back = P.offerFromMetadata({ elms_plan_id: plan.id }, plan); // a session from before terms: a one-time pack, no end date
assert.deepStrictEqual([back.priceUsd, back.credits, back.termMonths, back.name], [120, 6000, 0, 'Pro']);

// ---- a term from a date
const iso = (d) => d.toISOString().slice(0, 10);
assert.strictEqual(iso(P.addMonths(new Date('2026-09-25T10:00:00Z'), 1)), '2026-10-25');
assert.strictEqual(iso(P.addMonths(new Date('2026-01-31T10:00:00Z'), 1)), '2026-02-28', 'no jump into March');
assert.strictEqual(iso(P.addMonths(new Date('2026-09-25T10:00:00Z'), 12)), '2027-09-25');
assert.strictEqual(iso(P.addMonths(new Date('2028-02-29T10:00:00Z'), 12)), '2029-02-28');

// ---- paying: a yearly custom plan gives the term and 12 months of credits; renewing early adds up; a lapsed plan is closed first
const users = new Map();
const purchases = [];
const emails = [];
stub('models/plansModel', { getPlanById: async (id) => (id === plan.id ? plan : null) });
stub('models/purchasesModel', { recordPurchase: async (p) => { if (purchases.some((x) => x.providerTransactionId === p.providerTransactionId)) return null; purchases.push(p); return { ...p, id: 'p' + purchases.length }; } });
stub('models/usersModel', {
  addCredits: async (id, n) => { users.get(id).creditBalance += n; },
  getUserById: async (id) => ({ id, ...users.get(id) }),
  setMaxEbayAccounts: async (id, n) => { users.get(id).maxEbayAccounts = n; },
});
const matches = (u, f) => Object.entries(f).every(([k, v]) => {
  if (k === '_id') return true;
  if (v && typeof v === 'object' && '$ne' in v) return v.$ne === null ? u[k] != null : u[k] !== v.$ne;
  if (v && typeof v === 'object' && '$lte' in v) return u[k] != null && u[k] <= v.$lte;
  return u[k] === v || (v instanceof Date && u[k] instanceof Date && +u[k] === +v);
});
stub('models/schemas/User', {
  updateOne: async ({ _id, ...rest }, u) => { const x = users.get(String(_id)); if (!x || !matches(x, rest)) return { modifiedCount: 0 }; Object.assign(x, u.$set); return { modifiedCount: 1 }; },
  findOne: (f, proj) => ({ lean: async () => { const [id, x] = [...users.entries()].find(([, u]) => u.role !== 'admin' && u.planExpiresAt && u.planExpiresAt <= f.planExpiresAt.$lte) || []; return id ? { _id: id, ...x } : null; } }),
  find: () => ({ limit: () => ({ lean: async () => [...users.entries()].filter(([, u]) => u.role !== 'admin' && u.planExpiresAt).map(([id]) => ({ _id: id })) }) }),
});
stub('services/emailService', { sendAdminAlert: async () => {}, sendPurchaseReceiptEmail: async () => {}, sendPlanEndedEmail: async (m) => { emails.push(m); } });
stub('models/referralsModel', { findReferralByReferred: async () => null });
stub('models/settingsModel', { getAffiliateSettings: async () => ({ enabled: false }), getReferralSettings: async () => ({ enabled: false, discountPercent: 0, discountUses: 1, discountDays: 0, rewardCredits: 0 }) });
const { fulfillPurchase } = require('../services/purchaseFulfillmentService');
const { expireIfDue, expireDuePlans } = require('../services/planExpiryService');

(async () => {
  users.set('u1', { email: 'a@x.com', creditBalance: 10, maxEbayAccounts: 1, planName: null, planExpiresAt: null });
  const yearly = P.customOffer(s, { amountUsd: 120, billing: 'yearly', extraStores: 1 });
  let r = await fulfillPurchase({ userId: 'u1', plan: yearly, provider: 'cashtap', transactionId: 'T1', priceUsd: yearly.priceUsd });
  assert.strictEqual(r.granted, true);
  let u = users.get('u1');
  assert.strictEqual(u.creditBalance, 10 + 72000);
  assert.strictEqual(u.maxEbayAccounts, 2);
  assert.strictEqual(u.planPrevMaxEbayAccounts, 1, 'the limit before the plan is remembered');
  assert.strictEqual(u.planTerm, 'yearly');
  const days = (u.planExpiresAt - Date.now()) / 86400000;
  assert.ok(days > 364 && days < 367, 'about a year ahead, got ' + days);
  assert.strictEqual(purchases[0].planId, null, 'the custom plan has no plan record');
  assert.strictEqual(purchases[0].billing, 'yearly');
  assert.strictEqual(purchases[0].termMonths, 12);
  assert.ok(/Custom plan \(yearly, 1 extra eBay store\)/.test(purchases[0].planName));

  // renewing while it runs: one more term on from the end, credits add up, the remembered limit stays
  const firstEnd = +u.planExpiresAt;
  const monthly = P.planOffer(plan, 'monthly');
  await fulfillPurchase({ userId: 'u1', plan: monthly, provider: 'cashtap', transactionId: 'T2', priceUsd: 120 });
  u = users.get('u1');
  assert.strictEqual(u.creditBalance, 10 + 72000 + 6000);
  assert.strictEqual(u.planPrevMaxEbayAccounts, 1);
  assert.ok(+u.planExpiresAt > firstEnd + 27 * 86400000 && +u.planExpiresAt < firstEnd + 32 * 86400000, 'a month after the old end');
  assert.strictEqual(u.planTerm, 'monthly');

  // a pack from before terms has no end date
  users.set('old', { email: 'o@x.com', creditBalance: 0, maxEbayAccounts: 1, planExpiresAt: null });
  await fulfillPurchase({ userId: 'old', plan: { id: plan.id, name: 'Pro', priceUsd: 120, credits: 6000, maxEbayAccounts: 2, billing: null, termMonths: 0 }, provider: 'cashtap', transactionId: 'T3', priceUsd: 120 });
  assert.strictEqual(users.get('old').planExpiresAt, null);
  assert.strictEqual(users.get('old').creditBalance, 6000);

  // the end: credits go, the limit goes back, the mail is sent once
  users.get('u1').planExpiresAt = new Date(Date.now() - 1000);
  assert.strictEqual(await expireIfDue('u1'), true);
  u = users.get('u1');
  assert.deepStrictEqual([u.creditBalance, u.maxEbayAccounts, u.planExpiresAt, u.planTerm, u.planName], [0, 1, null, null, null]);
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(await expireIfDue('u1'), false, 'a second call finds nothing to close');
  assert.strictEqual(emails.length, 1);

  // an admin is never touched; a plan that has not ended yet is left alone
  users.set('boss', { email: 'b@x.com', role: 'admin', creditBalance: 999999, maxEbayAccounts: 5, planExpiresAt: new Date(Date.now() - 1000) });
  users.set('later', { email: 'l@x.com', creditBalance: 50, maxEbayAccounts: 3, planExpiresAt: new Date(Date.now() + 86400000) });
  assert.strictEqual(await expireDuePlans(), 0);
  assert.strictEqual(users.get('boss').creditBalance, 999999);
  assert.strictEqual(users.get('later').creditBalance, 50);

  // a lapsed plan is closed before a new purchase, so the new credits start clean and the limit is not "remembered" as the raised one
  users.set('lapsed', { email: 'p@x.com', creditBalance: 400, maxEbayAccounts: 4, planPrevMaxEbayAccounts: 1, planExpiresAt: new Date(Date.now() - 5000), planName: 'Pro' });
  await fulfillPurchase({ userId: 'lapsed', plan: monthly, provider: 'cashtap', transactionId: 'T4', priceUsd: 120 });
  u = users.get('lapsed');
  assert.strictEqual(u.creditBalance, 6000, 'the old 400 ended, the new 6000 started');
  assert.strictEqual(u.planPrevMaxEbayAccounts, 1);
  assert.strictEqual(u.maxEbayAccounts, 2);

  console.log('planTerms tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
