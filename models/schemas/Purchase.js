const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },

    // Generic fields so a future payment provider (e.g. a card processor)
    // can reuse this same model - not hardcoded to Paddle specifics.
    provider: { type: String, enum: ['paddle'], default: 'paddle' },
    providerTransactionId: { type: String, required: true, unique: true }, // Paddle transaction ID - also used to prevent double-crediting

    priceUsd: { type: Number, required: true },
    creditsGranted: { type: Number, required: true },
    status: { type: String, enum: ['completed', 'refunded'], default: 'completed' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Purchase', purchaseSchema);
