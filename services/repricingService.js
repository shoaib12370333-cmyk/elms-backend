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

module.exports = { normalizeMoney, getSavedMargin, calculateRepricedSellPrice };
