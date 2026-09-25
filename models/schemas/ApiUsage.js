const mongoose = require('mongoose');

/**
 * How many eBay Trading API calls ELMS has made today (all sellers together: eBay's daily limit is per application).
 * One row per day, e.g. key "trading:2026-09-26". See services/ebayCallBudget.js.
 */
const apiUsageSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    total: { type: Number, default: 0 },   // every Trading call counted today
    stats: { type: Number, default: 0 },   // the part spent on views / watchers
    exhausted: { type: Boolean, default: false }, // eBay itself said the daily limit is reached
    exhaustedAt: { type: Date, default: null },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true }
);
// The rows are only bookkeeping: MongoDB removes them a few days after their day.
apiUsageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ApiUsage', apiUsageSchema);
