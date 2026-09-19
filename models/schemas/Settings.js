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

    // Published Chrome Web Store extension ID used for production CORS.
    // Admin-configurable so no redeploy is required when the extension is published.
    chromeExtensionId: { type: String, default: null, trim: true },

    // Public registration URL shown inside the Chrome extension when the user
    // does not have an ELMS account yet. Admin-configurable so it can change
    // without publishing a new extension build.
    extensionRegistrationUrl: { type: String, default: null, trim: true },

    // Canonical API endpoint used by the browser extension. Users never edit
    // this in the extension; admins can change it centrally.
    extensionBackendUrl: { type: String, default: 'https://elms-backend-1-tr5h.onrender.com', trim: true },

    // Admin-editable overrides for config/actionCosts.js's ACTION_COSTS
    // defaults (e.g. { AMAZON_IMPORT: 2 }). Only keys present here override
    // their matching default - anything not overridden keeps using the
    // code default. See models/settingsModel.js for how these are applied.
    // AI features (title + description). Admin-controlled from the Admin Panel.
    aiTitleEnabled: { type: Boolean, default: true },
    aiDescriptionEnabled: { type: Boolean, default: true },
    aiAspectsEnabled: { type: Boolean, default: true },
    aiReplyEnabled: { type: Boolean, default: true },
    aiModel: { type: String, default: null, trim: true },
    aiDescriptionLength: { type: String, enum: ['short', 'standard', 'detailed'], default: 'standard' },
    aiCustomInstructions: { type: String, default: '', trim: true, maxlength: 600 },

    actionCosts: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
