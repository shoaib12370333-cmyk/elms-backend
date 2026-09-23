const mongoose = require('mongoose');

/**
 * A message from an admin that pops up on the user's screen (an offer, a warning, a remark).
 * userId null = everyone. `seenBy` records who pressed OK, so it shows once per person.
 */
const adminNoticeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    kind: { type: String, enum: ['message', 'offer', 'warning'], default: 'message' },
    title: { type: String, required: true },
    body: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    expiresAt: { type: Date, default: null },
    seenBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);
adminNoticeSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdminNotice', adminNoticeSchema);
