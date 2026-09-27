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

/**
 * ELMS CJdropshipping SKU policy: eBay SKU is "CJ-" + the CJ variant SKU, uppercased. The prefix is what keeps a CJ listing's
 * SKU from ever colliding with an Amazon one in the same {userId, ebayAccountId, sku} unique index (models/schemas/Listing.js)
 * - an Amazon SKU is exactly a 10-character ASIN (requireAsinSku above) and never starts with "CJ-".
 */
function cjSkuFor(variantSku, context = 'CJ product') {
  const clean = String(variantSku || '').trim().toUpperCase();
  if (!clean) throw new Error(`A CJ variant SKU is required to create an eBay SKU for this ${context}.`);
  return 'CJ-' + clean;
}

module.exports = { normalizeAsinSku, requireAsinSku, cjSkuFor };
