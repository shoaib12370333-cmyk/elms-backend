const mongoose = require('mongoose');

/** What an affiliate earned from one payment of someone they brought. One row per purchase (unique). */
const commissionSchema = new mongoose.Schema(
  {
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true, unique: true },
    paidUsd: { type: Number, required: true }, // what the customer paid
    percent: { type: Number, required: true }, // the rate at that moment
    commissionUsd: { type: Number, required: true },
    status: { type: String, enum: ['active', 'void', 'paid'], default: 'active' },
    availableAt: { type: Date, required: true }, // the hold ends here (refund protection)
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePayout', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AffiliateCommission', commissionSchema);
