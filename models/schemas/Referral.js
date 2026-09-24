const mongoose = require('mongoose');

/**
 * One row per referred account: who brought them, and what came of it. A person can be referred once (unique referredUserId).
 * The discount they get and the credits the referrer earns are decided by services/referralService.js when a purchase is made;
 * this row keeps the counters that decide "how many discounted purchases are left" and "was the referrer already rewarded".
 */
const referralSchema = new mongoose.Schema(
  {
    referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    code: { type: String, required: true }, // the code that was used (the referrer may change it later)
    ip: { type: String, default: null },
    discountedPurchases: { type: Number, default: 0 }, // purchases that already used the discount
    purchases: { type: Number, default: 0 },
    totalSpentUsd: { type: Number, default: 0 },
    firstPurchaseAt: { type: Date, default: null },
    rewardedAt: { type: Date, default: null }, // the referrer's credits were given (once)
    rewardCredits: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Referral', referralSchema);
