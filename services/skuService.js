/**
 * ELMS SKU policy: eBay SKU must be the Amazon ASIN only.
 * Legacy values such as AMZ-B0XXXXXXXX are normalized to B0XXXXXXXX.
 */
function normalizeAsinSku(value) {
  if (value === null || value === undefined) return null;
  const sku = String(value).trim().replace(/^AMZ-/i, '').trim().toUpperCase();
  return sku || null;
}

function requireAsinSku(value, context = 'product') {
  const sku = normalizeAsinSku(value);
  if (!sku) throw new Error(`Amazon ASIN is required to create an eBay SKU for this ${context}.`);
  if (!/^[A-Z0-9]{10}$/.test(sku)) {
    throw new Error(`Invalid Amazon ASIN "${sku}". The eBay SKU must contain the 10-character ASIN only.`);
  }
  return sku;
}

module.exports = { normalizeAsinSku, requireAsinSku };
