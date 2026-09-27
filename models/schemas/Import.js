const mongoose = require('mongoose');

const importSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Where this product came from. See models/schemas/Listing.js for the full "never mix" rule; existing rows are backfilled
    // to 'amazon' by db.js migrateSourcePlatformDefault.
    sourcePlatform: { type: String, enum: ['amazon', 'cj', 'aliexpress'], required: true, default: 'amazon' },
    cjProductId: { type: String, default: null },
    cjVariantId: { type: String, default: null },
    aliexpressProductId: { type: String, default: null },
    aliexpressSkuId: { type: String, default: null },
    asin: { type: String, default: null },
    title: { type: String, default: null },
    amazonUrl: { type: String, default: null },
    amazonPrice: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    mainImage: { type: String, default: null },
    product: { type: mongoose.Schema.Types.Mixed, required: true }, // full normalized product object
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null, index: true },
    suggestedPrice: { type: Number, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

module.exports = mongoose.model('Import', importSchema);
