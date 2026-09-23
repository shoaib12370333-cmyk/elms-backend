const mongoose = require('mongoose');

/**
 * A blocked IP address (and optionally blocked browsers / devices).
 * An IP is NOT one person: a family, an office or a mobile carrier can share it. So a block never
 * touches the accounts the admin chose to let through (`exemptUserIds`, filled with the regular
 * accounts seen on that IP when the block is created) or admin accounts. It stops everyone else:
 * the accounts that were suspended with it and every new or unknown account.
 */
const ipBlockSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true },
    // Random browser ids (the x-device-id the site sends). Blocks the same browser on another IP too.
    deviceIds: { type: [String], default: [] },
    // Shown to the person who is blocked.
    reason: { type: String, required: true },
    // Private note for the admins.
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    expiresAt: { type: Date, default: null },
    exemptUserIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // Accounts suspended together with this block (so lifting it can offer to reinstate them).
    suspendedUserIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    active: { type: Boolean, default: true },
    liftedAt: { type: Date, default: null },
    liftedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
  },
  { timestamps: true }
);
// One live block per address.
ipBlockSchema.index({ ip: 1 }, { unique: true, partialFilterExpression: { active: true } });
ipBlockSchema.index({ deviceIds: 1 });

module.exports = mongoose.model('IpBlock', ipBlockSchema);
