const MAX_EBAY_SKU = 50; // eBay's Inventory API sku field: 50 characters at most

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
 * ELMS CJdropshipping SKU policy: eBay SKU is "CJ-" + the CJ variant's OWN id (cjVariantId, e.g. "D4057F56-3F09-4541-8461-
 * 9D76D014846D") - never the supplier's own variant SKU text. A supplier's sku is theirs to change shape, length and
 * characters however they like (long, with slashes, non-ASCII ...) and none of that is ELMS' to send to eBay; the variant id
 * is always a short, fixed-shape, already-safe string, and it is already the exact thing ELMS itself uses to look the
 * variant up again (cjVariantId - the same rule a future second supplier, e.g. AliExpress, would follow: its own product/
 * variant id, never its sku text). The "CJ-" prefix is what keeps a CJ listing's sku from ever colliding with an Amazon one
 * in the same {userId, ebayAccountId, sku} unique index (models/schemas/Listing.js) - an Amazon sku is exactly a 10-
 * character ASIN (requireAsinSku above) and never starts with "CJ-".
 */
function cjSkuFor(cjVariantId, context = 'CJ product') {
  const clean = String(cjVariantId || '').trim();
  if (!clean) throw new Error(`A CJ variant id is required to create an eBay SKU for this ${context}.`);
  // Capped at eBay's own 50-character sku limit as a safety net (a CJ variant id is normally well under this already).
  // Truncating here (not just at publish time) keeps the same draft's sku identical every time it is looked up
  // (findCjListingInStore, the unique index), instead of it silently changing shape the first time it is published.
  return ('CJ-' + clean).slice(0, MAX_EBAY_SKU);
}

/**
 * The sku a draft already carries - Amazon (requireAsinSku, exactly 10 characters) or CJ (cjSkuFor, already capped at 50) -
 * is sent to eBay as it is; this is only the last-mile safety net at publish time (services/ebayListingService.js), so a sku
 * saved before this length cap existed, or from any other future source, still never reaches eBay too long.
 */
function finalizeEbaySku(value, context = 'product') {
  const sku = String(value || '').trim();
  if (!sku) throw new Error(`An eBay SKU is required to publish this ${context}.`);
  return sku.slice(0, MAX_EBAY_SKU);
}

/**
 * ELMS AliExpress SKU policy: eBay SKU is "AE-" + the AliExpress sku's OWN id (aliexpressSkuId, AliExpress's `sku_id` from
 * aliexpress.ds.product.get's ae_item_sku_info_dtos) - never the supplier's own sku_code/barcode text, for the same reason as
 * cjSkuFor above (a supplier's own sku text can be any length/shape, and none of that is ELMS' to send to eBay). The "AE-"
 * prefix keeps it from ever colliding with an Amazon ASIN (requireAsinSku) or a CJ "CJ-..." sku (cjSkuFor) in the same
 * {userId, ebayAccountId, sku} unique index.
 */
function aliSkuFor(aliexpressSkuId, context = 'AliExpress product') {
  const clean = String(aliexpressSkuId || '').trim();
  if (!clean) throw new Error(`An AliExpress sku id is required to create an eBay SKU for this ${context}.`);
  return ('AE-' + clean).slice(0, MAX_EBAY_SKU);
}

module.exports = { normalizeAsinSku, requireAsinSku, cjSkuFor, aliSkuFor, finalizeEbaySku, MAX_EBAY_SKU };
