const { computePrice } = require('./pricingService');

function normalizeMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function getSavedMargin(listing) {
  const explicit = normalizeMoney(listing?.margin_amount ?? listing?.marginAmount);
  if (explicit != null) return explicit;
  const source = normalizeMoney(listing?.amazon_price ?? listing?.amazonPrice);
  const sell = normalizeMoney(listing?.sell_price ?? listing?.sellPrice);
  if (source != null && sell != null) return normalizeMoney(sell - source);
  return null;
}

function calculateRepricedSellPrice(sourcePrice, marginAmount) {
  const source = normalizeMoney(sourcePrice);
  const margin = normalizeMoney(marginAmount);
  if (source == null || margin == null) return null;
  const result = normalizeMoney(source + margin);
  return result != null && result > 0 ? result : null;
}

/**
 * The new eBay price for a listing whose Amazon price changed.
 *  - A listing that was priced by the seller's pricing rule (it keeps a copy of that rule, with its money in the listing's currency)
 *    is priced by the same rule again, so its fees and profit % stay what the seller chose.
 *  - Any other listing keeps its cash margin (eBay price minus Amazon price), as it always did.
 * @returns {null | { sellPrice: number, marginAmount: number, rule: object|null }} null when no valid price comes out
 */
function repriceFor(listing, newSourcePrice, fallbackMargin) {
  const rule = listing && listing.pricing_rule && typeof listing.pricing_rule === 'object' ? listing.pricing_rule : null;
  if (rule) {
    const breakdown = computePrice(newSourcePrice, rule);
    const source = normalizeMoney(newSourcePrice);
    if (!breakdown || source == null) return null;
    return { sellPrice: breakdown.price, marginAmount: Number((breakdown.price - source).toFixed(2)), rule };
  }
  const sellPrice = calculateRepricedSellPrice(newSourcePrice, fallbackMargin);
  return sellPrice == null ? null : { sellPrice, marginAmount: fallbackMargin, rule: null };
}

module.exports = { normalizeMoney, getSavedMargin, calculateRepricedSellPrice, repriceFor };
