const mongoose = require('mongoose');

/**
 * A public, carrier/source-agnostic tracking code (e.g. "ELM36493") the buyer can look up at elmstool.com/track/<code>
 * without ever seeing the real tracking number or which supplier (Amazon/AliExpress/CJ) it came from. The real number
 * and its 17TRACK-assigned carrier stay here; only status/statusDetail/statusAt are ever shown publicly.
 */
const trackingLinkSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    trackingNumber: { type: String, required: true },
    carrier17: { type: Number, default: null }, // 17TRACK's own numeric carrier code, from registration (auto-detected if not given)
    status: { type: String, default: null }, // 17TRACK's latest_status.status, e.g. "InTransit", "Delivered"
    statusDetail: { type: String, default: null }, // latest_event.description
    statusAt: { type: Date, default: null },
    registeredAt: { type: Date, default: null }, // when 17TRACK accepted this number; null if registration failed/is pending
  },
  { timestamps: true }
);

trackingLinkSchema.index({ code: 1 }, { unique: true });
trackingLinkSchema.index({ orderId: 1, trackingNumber: 1 });
trackingLinkSchema.index({ trackingNumber: 1, carrier17: 1 }); // looked up by the webhook, which only gives number+carrier

module.exports = mongoose.model('TrackingLink', trackingLinkSchema);
