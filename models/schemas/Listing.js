const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Which of the user's (possibly several) connected eBay accounts this
    // listing belongs to / was published through. Null for drafts created
    // before an account was chosen.
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'Import', default: null },
    sku: { type: String, required: true },
    title: { type: String, default: null },
    mainImage: { type: String, default: null },
    // Draft-specific photo gallery. When empty, publishing falls back to the linked Amazon import gallery.
    images: { type: [String], default: [] },
    // True once the seller explicitly edits the draft gallery, including deleting all photos.
    imagesCustomized: { type: Boolean, default: false },
    sellPrice: { type: Number, default: null },
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
      enum: ['draft', 'publishing', 'scheduled', 'published', 'error', 'ended'],
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

// SKU only needs to be unique per user, not globally - two different
// sellers may otherwise generate the same SKU from the same ASIN.
listingSchema.index({ userId: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('Listing', listingSchema);
