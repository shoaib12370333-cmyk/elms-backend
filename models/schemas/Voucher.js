const mongoose = require('mongoose');

/**
 * A voucher an admin gave to ONE user (Admin -> Vouchers). Vouchers are never created by users and are not transferable.
 *   purchase_discount  a percent or an amount off a credit plan at checkout (any plan, or only `planId`)
 *   credits            free credits, added when the user redeems it
 *   free_plan          a plan (`planId`) for free: its credits, eBay-account limit and name, when the user redeems it
 *   ebay_accounts      more eBay accounts the user may connect, when the user redeems it
 * It works once: status goes active -> used (or revoked by an admin); an expired one simply stops being usable.
 */
const voucherSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['purchase_discount', 'credits', 'free_plan', 'ebay_accounts'], required: true },
    percent: { type: Number, default: null },
    amountUsd: { type: Number, default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
    credits: { type: Number, default: null },
    ebayAccounts: { type: Number, default: null },
    note: { type: String, default: '' }, // what the user sees ("Welcome gift", "Sorry for the delay")
    expiresAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'used', 'revoked'], default: 'active' },
    usedAt: { type: Date, default: null },
    usedFor: { type: String, default: null }, // the payment id it was used on, or "redeemed"
    revokedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
voucherSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Voucher', voucherSchema);
