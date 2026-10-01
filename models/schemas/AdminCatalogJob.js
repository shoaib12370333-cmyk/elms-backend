const mongoose = require('mongoose');

/**
 * One admin "bulk-fetch these Amazon links into the Product Catalog" run (Admin Panel > Product Catalog, see
 * jobs/adminCatalogProcessor.js). Same submit-then-poll shape as models/schemas/BulkImportJob.js (Easyparser's Bulk
 * API), but items are never charged to anyone and never become a Draft directly - a successful item becomes a
 * ProductCatalogItem row instead (catalogItemId), to be pushed into a chosen seller's Drafts later.
 *
 * Item lifecycle: pending (submitted, waiting) -> done (catalogItemId set) | error (Easyparser failed, or timed out).
 */
const itemSchema = new mongoose.Schema(
  {
    amazonUrl: { type: String, required: true },
    asin: { type: String, required: true },
    country: { type: String, required: true },
    status: { type: String, enum: ['pending', 'done', 'error'], default: 'pending' },
    queryId: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    catalogItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductCatalogItem', default: null },
    error: { type: String, default: null },
  },
  { _id: false }
);

const adminCatalogJobSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    marketplaceId: { type: String, required: true },
    status: { type: String, enum: ['queued', 'polling', 'done', 'cancelled'], default: 'queued', index: true },
    items: { type: [itemSchema], default: [] },
    total: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    submitAttempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    finishedAt: { type: Date, default: null },
    lastProcessedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
adminCatalogJobSchema.index({ status: 1, lastProcessedAt: 1 });

module.exports = mongoose.model('AdminCatalogJob', adminCatalogJobSchema);
