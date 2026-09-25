const { normalizeRule, computePrice, ruleInCurrency } = require('./pricingService');
const { getPricingRule } = require('../models/usersModel');
const { convertAmount } = require('./currencyService');

/** A markup % came with the request (an empty box or a missing value means "not given"). */
const markupGiven = (value) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');

function fail(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Prices a product that is being imported with the seller's pricing rule (Settings -> Pricing), when the rule applies.
 *
 * The rule applies only when ALL of these hold: the request carries no markup % of its own (a markup typed on the Import page, or
 * sent by an older extension, always wins and works exactly as it always did), and the seller has a rule that is switched on.
 * Otherwise this returns null and the caller keeps its own, unchanged, way of pricing.
 *
 * When the rule applies but cannot be used safely, this THROWS instead of falling back: a fallback would price the product at its
 * cost. That is a broken rule, or a rule in another currency whose exchange rate is not available right now.
 *
 * `pricingRule` is a rule kept earlier (a background bulk import takes the seller's rule when it starts, so the whole list is
 * priced by the rule of that moment); `undefined` = read the seller's saved rule now.
 *
 * @returns {Promise<null | { sellPrice: number, markupPercent: number, marginAmount: number, pricingRule: object, breakdown: object }>}
 *   pricingRule is what the draft keeps: the rule with its money amounts in the product's currency.
 */
async function priceByRule({ userId, price, currency, markupPercent, pricingRule }, deps = {}) {
  if (markupGiven(markupPercent)) return null;
  const cost = Number(price);
  if (price === null || price === undefined || !Number.isFinite(cost) || cost <= 0) return null;

  const stored = pricingRule !== undefined ? pricingRule : await (deps.getPricingRule || getPricingRule)(userId);
  if (!stored || stored.enabled !== true) return null;

  const { rule, errors } = normalizeRule(stored);
  if (!rule) throw fail('Your pricing rule is not valid (' + errors[0] + ') Open Settings > Pricing and save it again.', 409);

  const productCurrency = String(currency || '').toUpperCase() || rule.currency || null;
  let rate = 1;
  if (rule.currency && productCurrency && rule.currency !== productCurrency) {
    try {
      rate = (await (deps.convertAmount || convertAmount)(1, rule.currency, productCurrency)).rate;
    } catch (err) {
      throw fail('Your pricing rule is in ' + rule.currency + ' but this product is in ' + productCurrency + ', and the exchange rate could not be loaded (' + err.message + '). Try again in a minute.', 503);
    }
  }
  let snapshot;
  try {
    snapshot = ruleInCurrency(rule, productCurrency, rate);
  } catch (err) {
    throw fail(err.message, 503);
  }
  const breakdown = computePrice(cost, snapshot);
  if (!breakdown) throw fail('Your pricing rule cannot price this product. Check it in Settings > Pricing.', 409);
  return {
    sellPrice: breakdown.price,
    markupPercent: breakdown.markupPercent,
    marginAmount: Number((breakdown.price - cost).toFixed(2)),
    pricingRule: snapshot,
    breakdown,
  };
}

module.exports = { priceByRule, markupGiven };
