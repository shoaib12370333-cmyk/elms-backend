const ProductCache = require('../models/schemas/ProductCache');
const { getLimits } = require('../models/settingsModel');

// Domains are normalized case-insensitively so 'US'/'us' and '.COM'/'.com' hit the same entry.
function key(asin, domain) {
  return { asin: String(asin || '').toUpperCase(), domain: String(domain || '').toLowerCase() };
}

/**
 * A cache hit still charges the user's credit exactly like a fresh fetch (see
 * routes/fetchProduct.js saveProductAsDraft) - only the provider (Canopy/Easyparser) call is
 * skipped. How long an entry stays usable is the admin-set productCacheDays (default 7,
 * Admin Panel -> Limits); a row past that age is treated as a miss here even though it may
 * still physically exist until the database's own cleanup backstop removes it (see
 * models/schemas/ProductCache.js).
 */
async function getCachedProduct(asin, domain) {
  if (!asin) return null;
  const doc = await ProductCache.findOne(key(asin, domain)).lean();
  if (!doc) return null;
  const { productCacheDays } = await getLimits();
  const ageMs = Date.now() - new Date(doc.fetchedAt).getTime();
  if (ageMs > productCacheDays * 24 * 60 * 60 * 1000) return null;
  return doc.product;
}

async function setCachedProduct(asin, domain, product, source) {
  if (!asin || !product) return;
  const k = key(asin, domain);
  await ProductCache.findOneAndUpdate(k, { ...k, product, source: source || null, fetchedAt: new Date() }, { upsert: true });
}

module.exports = { getCachedProduct, setCachedProduct };
