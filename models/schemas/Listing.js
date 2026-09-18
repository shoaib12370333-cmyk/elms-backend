const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Which of the user's (possibly several) connected eBay accounts this
    // listing belongs to / was published through. Null for drafts created
    // before an account was chosen.
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null },
    // Marketplace captured with the draft destination so a draft cannot silently
    // switch sites if the seller later changes account settings.
    marketplaceId: { type: String, default: null },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'Import', default: null },
    sku: { type: String, required: true },
    title: { type: String, default: null },
    mainImage: { type: String, default: null },
    // Draft-specific photo gallery. When empty, publishing falls back to the linked Amazon import gallery.
    images: { type: [String], default: [] },
    // True once the seller explicitly edits the draft gallery, including deleting all photos.
    imagesCustomized: { type: Boolean, default: false },
    sellPrice: { type: Number, default: null },
    // Phase 2 source-price snapshot used as the repricing baseline.
    amazonPrice: { type: Number, default: null },
    // Fixed cash margin preserved when source price changes.
    marginAmount: { type: Number, default: null },
    repricingEnabled: { type: Boolean, default: true },
    lastRepricedAt: { type: Date, default: null },
    lastStockCheckedAt: { type: Date, default: null },
    // Phase 3: last supplier availability state successfully synchronized to eBay.
    amazonInStock: { type: Boolean, default: null },
    lastStockSyncedAt: { type: Date, default: null },
    draftCustomized: { type: Boolean, default: false },
    // Draft snapshot fields: the exact values saved in Edit Draft are reused
    // during publish, so later changes to the source import cannot silently
    // change what the seller saved.
    description: { type: String, default: '' },
    bulletPoints: { type: [String], default: [] },
    specifications: { type: [mongoose.Schema.Types.Mixed], default: [] },
    ebayAspects: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Markup applied to the Amazon/source price when this draft was created.
    markupPercent: { type: Number, default: 0 },
    // The currency sellPrice is denominated in (e.g. "USD", "GBP") -
    // matches whichever Amazon marketplace this product was fetched from.
    // Missing on older listings created before this field existed.
    currency: { type: String, default: 'USD' },
    quantity: { type: Number, default: 1 },
    categoryId: { type: String, default: null },
    ebayOfferId: { type: String, default: null },
    ebayListingId: { type: String, default: null },
    status: {
      type: String,
      enum: ['draft', 'publishing', 'scheduled', 'published', 'paused', 'error', 'ended'],
      default: 'draft',
    },
    publishStartedAt: { type: Date, default: null },
    publishCompletedAt: { type: Date, default: null },
    publishAttempts: { type: Number, default: 0 },
    publishCreditCharged: { type: Boolean, default: false },
    publishResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    ebayImageUrls: { type: [String], default: [] },
    publishErrorDetails: { type: mongoose.Schema.Types.Mixed, default: null },
    scheduledAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// SKU is the Amazon ASIN only and is unique per ELMS user; the same ASIN can be offered on multiple eBay marketplaces.
// sellers may otherwise generate the same SKU from the same ASIN.
listingSchema.index({ userId: 1, sku: 1 }, { unique: true });
listingSchema.index({ userId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Listing', listingSchema);
