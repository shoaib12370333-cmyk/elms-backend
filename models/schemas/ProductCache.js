const mongoose = require('mongoose');

/**
 * Caches a normalized Amazon product (see canopyAmazonService.normalizeProduct /
 * easyparserAmazonService.normalizeDetail - both produce the same shape) by ASIN +
 * marketplace domain, so importing the same product again (by any user, from a bulk
 * list or a single link) doesn't spend a second provider credit for 7 days. Amazon
 * price/stock can change in that window, so this is only used for the descriptive
 * fields at import time - the stock monitor always checks live, never this cache.
 */
const productCacheSchema = new mongoose.Schema({
  asin: { type: String, required: true },
  domain: { type: String, required: true }, // e.g. 'US' (Canopy) or '.com' (Easyparser) - see key() below
  product: { type: mongoose.Schema.Types.Mixed, required: true },
  source: { type: String, default: null }, // which provider it came from, for debugging
  fetchedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});
productCacheSchema.index({ asin: 1, domain: 1 }, { unique: true });

module.exports = mongoose.model('ProductCache', productCacheSchema);
