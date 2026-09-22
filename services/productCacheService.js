const ProductCache = require('../models/schemas/ProductCache');

// Domains are normalized case-insensitively so 'US'/'us' and '.COM'/'.com' hit the same entry.
function key(asin, domain) {
  return { asin: String(asin || '').toUpperCase(), domain: String(domain || '').toLowerCase() };
}

async function getCachedProduct(asin, domain) {
  if (!asin) return null;
  const doc = await ProductCache.findOne(key(asin, domain)).lean();
  return doc ? doc.product : null;
}

async function setCachedProduct(asin, domain, product, source) {
  if (!asin || !product) return;
  const k = key(asin, domain);
  await ProductCache.findOneAndUpdate(k, { ...k, product, source: source || null, fetchedAt: new Date() }, { upsert: true });
}

module.exports = { getCachedProduct, setCachedProduct };
