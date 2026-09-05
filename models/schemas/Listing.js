const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'Import', default: null },
    sku: { type: String, required: true },
    title: { type: String, default: null },
    mainImage: { type: String, default: null },
    sellPrice: { type: Number, default: null },
    quantity: { type: Number, default: 1 },
    categoryId: { type: String, default: null },
    ebayOfferId: { type: String, default: null },
    ebayListingId: { type: String, default: null },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'published', 'error', 'ended'],
      default: 'draft',
    },
    scheduledAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// SKU only needs to be unique per user, not globally - two different
// sellers may otherwise generate the same SKU from the same ASIN.
listingSchema.index({ userId: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('Listing', listingSchema);
