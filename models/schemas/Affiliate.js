const mongoose = require('mongoose');

/** An ELMS user who applied to promote ELMS for a commission (see services/affiliateRules.js). */
const affiliateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], default: 'pending' },
    code: { type: String, required: true, unique: true }, // the link is /?aff=CODE
    commissionPercent: { type: Number, default: null }, // null = the default from the admin settings
    payoutNetwork: { type: String, default: null }, // e.g. USDT_TRC20
    payoutAddress: { type: String, default: null },
    promo: { type: String, default: '', maxlength: 600 }, // how they plan to promote ELMS (from the application)
    adminNote: { type: String, default: '', maxlength: 600 },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Affiliate', affiliateSchema);
