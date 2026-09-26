const mongoose = require('mongoose');

/**
 * Answers of eBay's Taxonomy API that hardly ever change (a marketplace's category tree id, the item specifics of a category, a category's
 * name and leaf status, the category suggested for a product title). Kept in MongoDB so a restart or a deploy does not make ELMS ask eBay
 * again for everything: eBay counts every call against the application's daily limit. See services/ebayTaxonomyService.js.
 */
const taxonomyCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false }
);
// MongoDB removes a row when it is old.
taxonomyCacheSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TaxonomyCache', taxonomyCacheSchema);
