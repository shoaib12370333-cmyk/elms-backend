const mongoose = require('mongoose');

// One row per AI call, so the Admin Panel can show usage and spend.
const aiUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['title', 'description', 'aspects', 'reply'], required: true },
    ok: { type: Boolean, default: true },
    credits: { type: Number, default: 0 },
    model: { type: String, default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);
aiUsageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
