const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },

    // Generic fields so a future payment provider (e.g. a card processor)
    // can reuse this same model - not hardcoded to Paddle specifics.
    provider: { type: String, enum: ['paddle', 'cashtap', 'voucher'], default: 'paddle' }, // 'voucher' = a plan given free by a voucher
    providerTransactionId: { type: String, required: true, unique: true }, // Paddle transaction ID - also used to prevent double-crediting

    priceUsd: { type: Number, required: true }, // what the buyer paid
    listPriceUsd: { type: Number, default: null }, // the plan's price before a discount
    discountPercent: { type: Number, default: 0 }, // referral discount applied to this purchase
    referralId: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null }, // the voucher this purchase used
    creditsGranted: { type: Number, required: true },
    status: { type: String, enum: ['completed', 'refunded'], default: 'completed' },
    // for the invoice: what was bought, how it was paid, and its number (given the first time an invoice is made)
    planName: { type: String, default: null },
    paymentMethod: { type: String, default: null }, // what the buyer used, e.g. "Visa card", "PayPal"; empty = the provider's usual one
    invoiceNo: { type: String, index: { unique: true, sparse: true } }, // no default: an unnumbered purchase has no field at all (sparse unique)
  },
  { timestamps: true }
);

module.exports = mongoose.model('Purchase', purchaseSchema);
