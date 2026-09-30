const mongoose = require('mongoose');

/**
 * Records a completed "Buy Listings" payment. Kept apart from the credit-plan Purchase model (models/schemas/Purchase.js) on
 * purpose - a listing pack grants cloned drafts, not credits, and never touches plan/term fields. providerTransactionId is
 * unique so the same CashTap session (webhook retry racing the return-page check) is never fulfilled twice.
 */
const listingPackPurchaseSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: 'ListingPackTier', default: null },
    tierName: { type: String, default: null },
    provider: { type: String, enum: ['cashtap'], default: 'cashtap' },
    providerTransactionId: { type: String, required: true, unique: true },
    priceUsd: { type: Number, required: true },
    listingCount: { type: Number, required: true }, // what the tier promised
    pushed: { type: Number, default: 0 }, // how many drafts actually landed (the pool can run a little short)
  },
  { timestamps: true }
);

module.exports = mongoose.model('ListingPackPurchase', listingPackPurchaseSchema);
