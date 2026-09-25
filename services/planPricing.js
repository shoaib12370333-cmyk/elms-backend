/**
 * What a plan costs and gives for a chosen term, and the custom plan a buyer builds themselves. Pure functions: the server
 * decides every price and credit amount here, never the browser.
 *
 * Terms: one payment buys one month or one year. Nothing renews by itself; when the term ends the credits end with it
 * (services/planExpiryService.js) and the buyer buys again.
 *
 * A plan's own price is its MONTHLY price. Its yearly option exists only when the admin gave it a yearly price; a year gives
 * 12 months of credits at once. The custom plan: the buyer picks how many dollars a month (min..max) and how many extra eBay
 * stores; credits = dollars x creditsPerUsd; an extra store costs extraStoreMonthlyUsd a month; a year is 12 months minus
 * the admin's yearly discount.
 */
const CUSTOM_DEFAULTS = {
  enabled: true,
  minUsd: 80,
  maxUsd: 2000,
  creditsPerUsd: 50, // 120 USD = 6000 credits
  yearlyDiscountPercent: 10,
  includedStores: 1,
  extraStoreMonthlyUsd: 20,
  maxExtraStores: 20,
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fail = (message) => Object.assign(new Error(message), { userFacing: true, statusCode: 400 });
const billingOf = (b) => (String(b || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly');
const monthsOf = (billing) => (billing === 'yearly' ? 12 : 1);

/** A standard plan for a term. Returns the same shape the checkout and the fulfilment use everywhere. */
function planOffer(plan, billingInput) {
  const billing = billingOf(billingInput);
  if (billing === 'yearly') {
    const yearly = Number(plan.yearlyPriceUsd);
    if (!(yearly > 0)) throw fail('This plan has no yearly option.');
    return { id: plan.id, name: plan.name + ' (yearly)', priceUsd: round2(yearly), credits: Math.round(plan.credits * 12), maxEbayAccounts: plan.maxEbayAccounts || null, billing, termMonths: 12, paddlePriceId: null, custom: false };
  }
  return { id: plan.id, name: plan.name + ' (monthly)', priceUsd: round2(plan.priceUsd), credits: Math.round(plan.credits), maxEbayAccounts: plan.maxEbayAccounts || null, billing, termMonths: 1, paddlePriceId: plan.paddlePriceId || null, custom: false };
}

/** The custom plan for the chosen dollars, term and extra stores; throws a user-facing error when a choice is out of range. */
function customOffer(settings, { amountUsd, billing: billingInput, extraStores } = {}) {
  const s = { ...CUSTOM_DEFAULTS, ...(settings || {}) };
  if (!s.enabled) throw fail('The custom plan is not available right now.');
  const billing = billingOf(billingInput);
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || Math.round(amount) !== amount) throw fail('Choose a whole dollar amount.');
  if (amount < s.minUsd || amount > s.maxUsd) throw fail('Choose an amount between $' + s.minUsd + ' and $' + s.maxUsd + '.');
  const extra = extraStores === undefined || extraStores === null || extraStores === '' ? 0 : Number(extraStores);
  if (!Number.isInteger(extra) || extra < 0 || extra > s.maxExtraStores) throw fail('Extra eBay stores must be between 0 and ' + s.maxExtraStores + '.');

  const monthlyUsd = round2(amount + extra * s.extraStoreMonthlyUsd);
  const monthlyCredits = Math.round(amount * s.creditsPerUsd);
  const months = monthsOf(billing);
  const yearlyFull = round2(monthlyUsd * 12);
  const priceUsd = billing === 'yearly' ? round2(yearlyFull * (1 - s.yearlyDiscountPercent / 100)) : monthlyUsd;
  const stores = s.includedStores + extra;
  return {
    id: 'custom',
    name: 'Custom plan (' + billing + (extra ? ', ' + extra + ' extra eBay store' + (extra === 1 ? '' : 's') : '') + ')',
    priceUsd,
    credits: monthlyCredits * months,
    maxEbayAccounts: stores,
    billing,
    termMonths: months,
    paddlePriceId: null,
    custom: true,
    // what the buyer sees while choosing
    breakdown: { amountUsd: amount, extraStores: extra, extraStoresUsd: round2(extra * s.extraStoreMonthlyUsd), monthlyUsd, monthlyCredits, yearlyFullUsd: yearlyFull, yearlyDiscountPercent: billing === 'yearly' ? s.yearlyDiscountPercent : 0, includedStores: s.includedStores, stores },
  };
}

/** The offer a paid session was for, rebuilt from what the server put in its metadata (custom) or from the plan (standard). */
function offerFromMetadata(meta, plan) {
  const billing = billingOf(meta.elms_billing);
  if (String(meta.elms_plan_id) === 'custom') {
    const price = round2(meta.elms_price);
    const credits = Math.round(Number(meta.elms_credits));
    const stores = Math.round(Number(meta.elms_stores));
    const months = Math.round(Number(meta.elms_months));
    if (!(price > 0) || !(credits > 0) || !(stores >= 1) || ![1, 12].includes(months)) return null;
    return { id: 'custom', name: String(meta.elms_label || 'Custom plan').slice(0, 120), priceUsd: price, credits, maxEbayAccounts: stores, billing, termMonths: months, paddlePriceId: null, custom: true };
  }
  if (!plan) return null;
  // sessions made before terms existed carry no billing: they were a one-time pack
  if (!meta.elms_billing) return { id: plan.id, name: plan.name, priceUsd: round2(plan.priceUsd), credits: plan.credits, maxEbayAccounts: plan.maxEbayAccounts || null, billing: null, termMonths: 0, paddlePriceId: plan.paddlePriceId || null, custom: false };
  try { return planOffer(plan, billing); } catch (_) { return null; }
}

/** The custom-plan settings the admin saved, checked and filled with defaults. */
function normalizeCustomSettings(input = {}) {
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const s = {
    enabled: input.enabled === undefined || input.enabled === null ? CUSTOM_DEFAULTS.enabled : !!input.enabled,
    minUsd: Math.round(num(input.minUsd, CUSTOM_DEFAULTS.minUsd)),
    maxUsd: Math.round(num(input.maxUsd, CUSTOM_DEFAULTS.maxUsd)),
    creditsPerUsd: num(input.creditsPerUsd, CUSTOM_DEFAULTS.creditsPerUsd),
    yearlyDiscountPercent: num(input.yearlyDiscountPercent, CUSTOM_DEFAULTS.yearlyDiscountPercent),
    includedStores: Math.round(num(input.includedStores, CUSTOM_DEFAULTS.includedStores)),
    extraStoreMonthlyUsd: num(input.extraStoreMonthlyUsd, CUSTOM_DEFAULTS.extraStoreMonthlyUsd),
    maxExtraStores: Math.round(num(input.maxExtraStores, CUSTOM_DEFAULTS.maxExtraStores)),
  };
  if (s.minUsd < 1 || s.maxUsd < s.minUsd || s.maxUsd > 100000) throw fail('The lowest amount must be at least $1 and not above the highest ($100,000 at most).');
  if (!(s.creditsPerUsd > 0) || s.creditsPerUsd > 100000) throw fail('Credits per dollar must be more than 0.');
  if (s.yearlyDiscountPercent < 0 || s.yearlyDiscountPercent > 90) throw fail('The yearly discount must be between 0 and 90 percent.');
  if (s.includedStores < 1 || s.includedStores > 100) throw fail('Included eBay stores must be between 1 and 100.');
  if (s.extraStoreMonthlyUsd < 0 || s.extraStoreMonthlyUsd > 100000) throw fail('The price of an extra store must be 0 or more.');
  if (s.maxExtraStores < 0 || s.maxExtraStores > 100) throw fail('Extra stores a buyer can add must be between 0 and 100.');
  s.creditsPerUsd = round2(s.creditsPerUsd);
  s.yearlyDiscountPercent = round2(s.yearlyDiscountPercent);
  s.extraStoreMonthlyUsd = round2(s.extraStoreMonthlyUsd);
  return s;
}

/** The end of a term that starts at `from` (a Date). */
function addMonths(from, months) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

module.exports = { CUSTOM_DEFAULTS, planOffer, customOffer, offerFromMetadata, normalizeCustomSettings, addMonths, round2 };
