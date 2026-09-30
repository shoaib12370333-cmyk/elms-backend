const ProductCache = require('../models/schemas/ProductCache');
const { getLimits } = require('../models/settingsModel');

// Domains are normalized case-insensitively so 'US'/'us' and '.COM'/'.com' hit the same entry.
function key(asin, domain) {
  return { asin: String(asin || '').toUpperCase(), domain: String(domain || '').toLowerCase() };
}

/**
 * A product worth reusing for every later import of this ASIN: it must have at least one real picture. Amazon's own
 * page always has photos, so a normalized product with none is a sign the provider's (Canopy/Easyparser) answer was
 * itself incomplete (a transient scrape glitch, a rate limit, an unusual page for that one ASIN) - not a product
 * that genuinely has no images. Caching that would poison the ASIN for every seller who imports it until the cache
 * entry expires (up to productCacheDays, default 7), turning one bad fetch into "this product has no images" for
 * everyone, with no way to fix it by trying again - which is exactly the bug this guards against.
 */
function hasUsableImages(product) {
  return !!product && Array.isArray(product.images) && product.images.length > 0;
}

/**
 * A cache hit still charges the user's credit exactly like a fresh fetch (see
 * routes/fetchProduct.js saveProductAsDraft) - only the provider (Canopy/Easyparser) call is
 * skipped. How long an entry stays usable is the admin-set productCacheDays (default 7,
 * Admin Panel -> Limits); a row past that age is treated as a miss here even though it may
 * still physically exist until the database's own cleanup backstop removes it (see
 * models/schemas/ProductCache.js). A cached product with no images is also treated as a miss
 * (self-healing an entry that was written before hasUsableImages existed, or one that slipped
 * through some other way) - the caller does a fresh fetch instead of repeating the same gap.
 */
async function getCachedProduct(asin, domain) {
  if (!asin) return null;
  const doc = await ProductCache.findOne(key(asin, domain)).lean();
  if (!doc) return null;
  const { productCacheDays } = await getLimits();
  const ageMs = Date.now() - new Date(doc.fetchedAt).getTime();
  if (ageMs > productCacheDays * 24 * 60 * 60 * 1000) return null;
  if (!hasUsableImages(doc.product)) return null;
  return doc.product;
}

async function setCachedProduct(asin, domain, product, source) {
  if (!asin || !product || !hasUsableImages(product)) return;
  const k = key(asin, domain);
  await ProductCache.findOneAndUpdate(k, { ...k, product, source: source || null, fetchedAt: new Date() }, { upsert: true });
}

module.exports = { getCachedProduct, setCachedProduct };
