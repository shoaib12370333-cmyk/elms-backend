/**
 * The pricing rule: how the eBay selling price of a product is worked out from what it costs on Amazon.
 *
 *   cost'  = Amazon price + shipping you add
 *   price  = ( cost' x (1 + profit%) + fixed profit + fixed fee )  /  (1 - fee%)
 *
 * eBay takes its percentage from what the buyer pays in total (the price), not from the cost, so the fee % sits in the divisor and
 * the price that leaves the wanted profit is exact. The same maths as the Price Calculator and the browser extension.
 * (Example: cost 142.19, profit 10% + 0.30, fees 13% + 0.30 -> 180.47, of which fees are 23.46 and the profit is 14.52.)
 *
 * Money is worked in whole cents: the price is rounded to a cent once, the fee is rounded to a cent from that price, and the profit is
 * what is left, so cost + fees + profit add up to the price to the cent, always.
 *
 * Everything here is pure (no database, no network) so the number a preview shows is the number an import saves.
 */

const FIELD_LIMITS = Object.freeze({
  feePercent: { min: 0, max: 60 },
  feeFixed: { min: 0, max: 10000 },
  profitPercent: { min: 0, max: 1000 },
  profitFixed: { min: 0, max: 10000 },
  minProfit: { min: 0, max: 10000 },
  shipping: { min: 0, max: 10000 },
});
const MAX_TIERS = 10;
const MAX_COST = 1000000;

const DEFAULT_RULE = Object.freeze({
  enabled: false,
  currency: null,
  feePercent: 13,
  feeFixed: 0.3,
  profitPercent: 30,
  profitFixed: 0,
  minProfit: 0,
  shipping: 0,
  centsEnding: null,
  tiers: [],
});

const LABELS = Object.freeze({
  feePercent: 'Fees %',
  feeFixed: 'Fixed fee',
  profitPercent: 'Profit %',
  profitFixed: 'Fixed profit',
  minProfit: 'Minimum profit per product',
  shipping: 'Shipping price',
});

const toCents = (value) => Math.round(Number(value) * 100 + 1e-9);
const fromCents = (cents) => Number((cents / 100).toFixed(2));

/** A finite number from a number or a numeric string; null for empty / not a number. */
function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Checks and cleans a rule someone typed. Nothing is silently changed: a value that is out of range or not a number is an error
 * (a price rule that "fixes" a typo by itself is how a listing ends up at the wrong price). A field left out takes its default.
 * @returns {{ rule: object|null, errors: string[] }}
 */
function normalizeRule(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const rule = { enabled: src.enabled === true || src.enabled === 'true' };

  const currency = src.currency === null || src.currency === undefined || src.currency === '' ? null : String(src.currency).toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) errors.push('The currency must be a 3-letter code such as USD or GBP.');
  rule.currency = currency;

  for (const [field, { min, max }] of Object.entries(FIELD_LIMITS)) {
    const raw = src[field];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) { rule[field] = DEFAULT_RULE[field]; continue; }
    const n = numberOrNull(raw);
    if (n === null || n < min || n > max) { errors.push(`${LABELS[field]} must be a number between ${min} and ${max}.`); rule[field] = DEFAULT_RULE[field]; continue; }
    rule[field] = Number(n.toFixed(2));
  }

  const ending = src.centsEnding;
  if (ending === undefined || ending === null || ending === '' ) rule.centsEnding = null;
  else {
    const n = numberOrNull(ending);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 99) { errors.push('The price cents value must be a whole number from 0 to 99 (for example 99 for prices ending in .99).'); rule.centsEnding = null; }
    else rule.centsEnding = n;
  }

  rule.tiers = [];
  const tiers = src.tiers === undefined || src.tiers === null ? [] : src.tiers;
  if (!Array.isArray(tiers)) errors.push('The dynamic profit ranges must be a list.');
  else if (tiers.length > MAX_TIERS) errors.push(`Use at most ${MAX_TIERS} dynamic profit ranges.`);
  else {
    tiers.forEach((t, i) => {
      const n = i + 1;
      const from = numberOrNull(t && t.from);
      const to = t && (t.to === null || t.to === undefined || t.to === '') ? null : numberOrNull(t.to);
      const pp = numberOrNull(t && t.profitPercent);
      const pf = t && (t.profitFixed === null || t.profitFixed === undefined || t.profitFixed === '') ? 0 : numberOrNull(t.profitFixed);
      if (from === null || from < 0 || from > MAX_COST) { errors.push(`Range ${n}: "from" must be a cost of 0 or more.`); return; }
      if (to !== null && (to <= from || to > MAX_COST)) { errors.push(`Range ${n}: "to" must be more than "from" (or empty for no upper limit).`); return; }
      if (pp === null || pp < 0 || pp > FIELD_LIMITS.profitPercent.max) { errors.push(`Range ${n}: profit % must be a number between 0 and ${FIELD_LIMITS.profitPercent.max}.`); return; }
      if (pf === null || pf < 0 || pf > FIELD_LIMITS.profitFixed.max) { errors.push(`Range ${n}: fixed profit must be a number between 0 and ${FIELD_LIMITS.profitFixed.max}.`); return; }
      rule.tiers.push({ from: Number(from.toFixed(2)), to: to === null ? null : Number(to.toFixed(2)), profitPercent: Number(pp.toFixed(2)), profitFixed: Number(pf.toFixed(2)) });
    });
    if (!errors.length) {
      rule.tiers.sort((a, b) => a.from - b.from);
      for (let i = 1; i < rule.tiers.length; i += 1) {
        const prev = rule.tiers[i - 1];
        if (prev.to === null || prev.to > rule.tiers[i].from) { errors.push('The dynamic profit ranges must not overlap (each "to" must be no more than the next "from").'); break; }
      }
    }
  }

  return errors.length ? { rule: null, errors } : { rule, errors: [] };
}

/** The tier a cost falls in (from <= cost < to), or null. */
function tierFor(rule, cost) {
  const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    if (cost >= t.from && (t.to === null || cost < t.to)) return { index: i, ...t };
  }
  return null;
}

/** The lowest price, in cents, that is at least `cents` and ends in `.ending`. */
function roundUpToEnding(cents, ending) {
  let candidate = Math.floor((cents - ending) / 100) * 100 + ending;
  if (candidate < cents) candidate += 100;
  return Math.max(candidate, ending);
}

/**
 * The selling price for a product that costs `cost` (in the rule's currency), with everything that went into it.
 * @returns {null | { price, cost, shipping, costTotal, profitPercent, profitFixed, feePercent, feeFixed, fees, profit, marginPercent,
 *   markupPercent, tier, minProfitApplied, endingApplied }} null when the cost is not a positive number or the rule cannot price it
 */
function computePrice(cost, rule) {
  const c = numberOrNull(cost);
  if (c === null || c <= 0 || c > MAX_COST || !rule) return null;
  const feeRate = Number(rule.feePercent) / 100;
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) return null;

  const tier = tierFor(rule, c);
  const profitPercent = tier ? tier.profitPercent : Number(rule.profitPercent) || 0;
  const profitFixed = tier ? tier.profitFixed : Number(rule.profitFixed) || 0;
  const shipping = Number(rule.shipping) || 0;
  const feeFixed = Number(rule.feeFixed) || 0;
  const minProfit = Number(rule.minProfit) || 0;

  const costCents = toCents(c);
  const shippingCents = toCents(shipping);
  const totalCostCents = costCents + shippingCents;
  const feeFixedCents = toCents(feeFixed);
  const wantedFixedCents = toCents(profitFixed);

  const raw = (totalCostCents * (1 + profitPercent / 100) + wantedFixedCents + feeFixedCents) / (1 - feeRate);
  let priceCents = Math.round(raw + 1e-9);

  let endingApplied = false;
  const ending = rule.centsEnding === null || rule.centsEnding === undefined ? null : Number(rule.centsEnding);
  const withEnding = (cents) => {
    if (ending === null) return cents;
    const up = roundUpToEnding(cents, ending);
    if (up !== cents) endingApplied = true;
    return up;
  };
  const profitAt = (cents) => cents - totalCostCents - Math.round(cents * feeRate + 1e-9) - feeFixedCents;

  priceCents = withEnding(priceCents);

  // The minimum profit only ever raises the price (and keeps the price ending), never lowers it.
  let minProfitApplied = false;
  const minCents = toCents(minProfit);
  if (minCents > 0 && profitAt(priceCents) < minCents) {
    minProfitApplied = true;
    priceCents = Math.max(priceCents, Math.ceil((totalCostCents + minCents + feeFixedCents) / (1 - feeRate) - 1e-9));
    priceCents = withEnding(priceCents);
    for (let i = 0; i < 200 && profitAt(priceCents) < minCents; i += 1) priceCents = withEnding(priceCents + 1);
  }

  const feesCents = Math.round(priceCents * feeRate + 1e-9);
  const profitCents = priceCents - totalCostCents - feesCents - feeFixedCents;
  return {
    price: fromCents(priceCents),
    cost: fromCents(costCents),
    shipping: fromCents(shippingCents),
    costTotal: fromCents(totalCostCents),
    profitPercent,
    profitFixed: fromCents(wantedFixedCents),
    feePercent: Number(rule.feePercent),
    feeFixed: fromCents(feeFixedCents),
    fees: fromCents(feesCents),
    profit: fromCents(profitCents),
    marginPercent: Number(((profitCents / priceCents) * 100).toFixed(2)),
    markupPercent: Number((((priceCents / costCents) - 1) * 100).toFixed(2)),
    tier: tier ? { index: tier.index, from: tier.from, to: tier.to } : null,
    minProfitApplied,
    endingApplied,
  };
}

/**
 * The rule with its money amounts expressed in another currency (a rule typed in GBP, a product in USD). `rate` is what one unit
 * of the rule's currency is worth in the product's currency. Percentages are untouched. The result is what a draft keeps, so a
 * later re-pricing needs no exchange rate and always uses the same numbers.
 */
function ruleInCurrency(rule, currency, rate) {
  const target = String(currency || '').toUpperCase() || rule.currency || null;
  const factor = !rule.currency || !target || rule.currency === target ? 1 : Number(rate);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('No exchange rate is available to convert your pricing rule.');
  const money = (v) => Number((Number(v) * factor).toFixed(2));
  return {
    ...rule,
    currency: target,
    feeFixed: money(rule.feeFixed),
    profitFixed: money(rule.profitFixed),
    minProfit: money(rule.minProfit),
    shipping: money(rule.shipping),
    tiers: (rule.tiers || []).map((t) => ({ from: money(t.from), to: t.to === null ? null : money(t.to), profitPercent: t.profitPercent, profitFixed: money(t.profitFixed) })),
  };
}

module.exports = { DEFAULT_RULE, FIELD_LIMITS, MAX_TIERS, normalizeRule, computePrice, ruleInCurrency, tierFor, roundUpToEnding };
