const mongoose = require('mongoose');

/**
 * Single-document collection for global, admin-configurable app settings.
 * There is only ever one document here (upserted by key 'global').
 */
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },

    // Welcome bonus: credits automatically granted to a brand-new user
    // (their very first Google sign-in, or the moment they register with
    // email/password), if enabled.
    welcomeBonusEnabled: { type: Boolean, default: false },
    welcomeBonusCredits: { type: Number, default: 10 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
