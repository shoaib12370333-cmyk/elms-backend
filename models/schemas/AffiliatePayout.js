const mongoose = require('mongoose');

/** A payout request: the affiliate's available commissions, to be sent in USDT / USDC by the admin. The address is copied here so it cannot change under the admin. */
const payoutSchema = new mongoose.Schema(
  {
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    amountUsd: { type: Number, required: true },
    network: { type: String, required: true },
    address: { type: String, required: true },
    status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested' },
    txHash: { type: String, default: '' },
    adminNote: { type: String, default: '', maxlength: 600 },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true } // createdAt = when it was requested
);

module.exports = mongoose.model('AffiliatePayout', payoutSchema);
