const mongoose = require('mongoose');

/**
 * One row per signed-in browser/device. The session token carries its sid, so a session can be
 * ended from the Security page and the token stops working straight away.
 */
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sid: { type: String, required: true, unique: true },
    deviceId: { type: String, default: null },
    browser: { type: String, default: 'Unknown browser' },
    os: { type: String, default: 'Unknown system' },
    deviceType: { type: String, enum: ['desktop', 'mobile', 'tablet', 'unknown'], default: 'unknown' },
    ip: { type: String, default: null },
    city: { type: String, default: null },
    region: { type: String, default: null },
    country: { type: String, default: null },
    method: { type: String, default: 'password' },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true }
);
// MongoDB removes a session document once its token has expired anyway.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
