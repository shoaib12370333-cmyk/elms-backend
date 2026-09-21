const mongoose = require('mongoose');

/** Login activity: every sign-in (and every failed password attempt on a real account), kept for 180 days. */
const loginEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    success: { type: Boolean, default: true },
    method: { type: String, default: 'password' },
    deviceId: { type: String, default: null },
    browser: { type: String, default: null },
    os: { type: String, default: null },
    deviceType: { type: String, default: 'unknown' },
    ip: { type: String, default: null },
    city: { type: String, default: null },
    region: { type: String, default: null },
    country: { type: String, default: null },
    isNewDevice: { type: Boolean, default: false },
    sid: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
loginEventSchema.index({ userId: 1, createdAt: -1 });
loginEventSchema.index({ userId: 1, deviceId: 1, success: 1 });
loginEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('LoginEvent', loginEventSchema);
