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

    // Limits an admin can tune without a deploy.
    bulkImportMax: { type: Number, default: 25, min: 1, max: 50 },
    // Background bulk-job import cap (POST /api/fetch-product/bulk-job, Easyparser-backed) - much
    // higher than bulkImportMax since it doesn't run inside one HTTP request.
    bulkJobMax: { type: Number, default: 1000, min: 1, max: 5000 },
    mailBatchSize: { type: Number, default: 20, min: 1, max: 100 },
    mailDailyCap: { type: Number, default: 200, min: 1, max: 100000 },
    // How many days a fetched Amazon product (services/productCacheService.js) is reused
    // before importing that ASIN again spends a fresh provider call - a credit is still
    // charged either way (see routes/fetchProduct.js).
    productCacheDays: { type: Number, default: 7, min: 1, max: 90 },

    // Referral programme (Admin -> Referrals). A friend who signs up with someone's code gets referralDiscountPercent off
    // their first referralDiscountUses purchase(s) (for referralDiscountDays days after signing up, 0 = no limit); the person
    // who referred them earns referralRewardCredits when that friend makes their first purchase. An admin can override the
    // discount and the reward for a single referrer (User.referralDiscountPercent / referralRewardCredits).
    referralEnabled: { type: Boolean, default: true },
    referralDiscountPercent: { type: Number, default: 10, min: 0, max: 90 },
    referralDiscountUses: { type: Number, default: 1, min: 1, max: 100 },
    referralDiscountDays: { type: Number, default: 0, min: 0, max: 3650 },
    referralRewardCredits: { type: Number, default: 0, min: 0, max: 1000000 },

    // The custom plan a buyer builds (Admin -> Plans): see services/planPricing.js for the fields.
    customPlan: { type: mongoose.Schema.Types.Mixed, default: null },

    actionCosts: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
