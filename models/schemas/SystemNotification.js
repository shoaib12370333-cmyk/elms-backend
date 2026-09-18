const mongoose = require('mongoose');

const systemNotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'system', index: true },
    level: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    title: { type: String, required: true },
    message: { type: String, required: true },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

systemNotificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('SystemNotification', systemNotificationSchema);
