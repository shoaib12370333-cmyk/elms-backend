const mongoose = require('mongoose');

/**
 * Admin Panel > Product Catalog: a product the admin bulk-fetched from Amazon (via Easyparser, see
 * jobs/adminCatalogProcessor.js), kept separately from any one seller's Drafts so it can be pushed into
 * ANY seller's Drafts later (services/productCatalogPushService.js) - possibly more than once, to more than
 * one seller. categoryId/categoryName are the eBay taxonomy already resolved for marketplaceId at fetch time
 * (services/aiCategoryService.js), so a push needs no further AI call when the target seller's own store is
 * on the same marketplace. Rows past expiresAt are removed by jobs/catalogExpiry.js - never edited after being
 * pushed into a Draft, since upsertDraft copies these fields into that Listing document, not a reference to this one.
 */
const specSchema = new mongoose.Schema({ name: String, value: String }, { _id: false });

const productCatalogItemSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    asin: { type: String, required: true },
    amazonUrl: { type: String, default: null },
    country: { type: String, required: true }, // ELMS country code the product was fetched from, e.g. 'US', 'GB'
    marketplaceId: { type: String, required: true }, // the eBay marketplace categoryId/categoryName below were resolved against

    title: { type: String, default: null },
    description: { type: String, default: '' },
    bulletPoints: { type: [String], default: [] },
    images: { type: [String], default: [] },
    price: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    brand: { type: String, default: null },
    specifications: { type: [specSchema], default: [] },

    categoryId: { type: String, default: null },
    categoryName: { type: String, default: null },
    categoryError: { type: String, default: null }, // set when AI category resolution failed/was skipped - the row is still usable, just uncategorized

    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);
productCatalogItemSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ProductCatalogItem', productCatalogItemSchema);
