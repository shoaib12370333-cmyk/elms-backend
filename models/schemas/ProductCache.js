const mongoose = require('mongoose');

/**
 * Caches a normalized Amazon product (see canopyAmazonService.normalizeProduct /
 * easyparserAmazonService.normalizeDetail - both produce the same shape) by ASIN +
 * marketplace domain, so importing the same product again (by any user, from a bulk
 * list or a single link) doesn't spend a second provider credit. Amazon price/stock can
 * change over time, so this is only used for the descriptive fields at import time - the
 * stock monitor always checks live, never this cache.
 *
 * How long a cached entry is actually REUSED is an admin setting (Settings.productCacheDays,
 * default 7 - see services/productCacheService.js.getCachedProduct), checked in application
 * code rather than by a Mongo TTL index, since a TTL index's expireAfterSeconds is fixed at
 * index-creation time and can't be changed from the Admin Panel without a migration. The TTL
 * below is just a generous cleanup backstop (matches productCacheDays' own max of 90 days),
 * so rows are never kept forever even if nothing ever reads them again.
 */
const productCacheSchema = new mongoose.Schema({
  asin: { type: String, required: true },
  domain: { type: String, required: true }, // e.g. 'US' (Canopy) or '.com' (Easyparser) - see key() below
  product: { type: mongoose.Schema.Types.Mixed, required: true },
  source: { type: String, default: null }, // which provider it came from, for debugging
  fetchedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
});
productCacheSchema.index({ asin: 1, domain: 1 }, { unique: true });

module.exports = mongoose.model('ProductCache', productCacheSchema);
