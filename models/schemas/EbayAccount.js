const mongoose = require('mongoose');

/**
 * Represents ONE connected eBay account. A single ELMS user can have
 * multiple of these (2-3 typically) - this is what makes "multiple eBay
 * accounts per user" possible, replacing the old single-account fields
 * that used to live directly on the User document.
 */
const ebayAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    ebayUserId: { type: String, required: true }, // eBay's own username for this seller
    // Private ELMS label used to identify this connected seller in the UI.
    // It does not modify the real eBay username.
    displayName: { type: String, default: null, trim: true, maxlength: 60 },
    refreshTokenEncrypted: { type: String, required: true },
    refreshTokenExpiresAt: { type: Date, default: null },

    // Business policy IDs, set by the user from their own eBay Seller Hub
    // for THIS specific eBay account. Required before publishing with it.
    merchantLocationKey: { type: String, default: null },
    paymentPolicyId: { type: String, default: null },
    fulfillmentPolicyId: { type: String, default: null },
    returnPolicyId: { type: String, default: null },
    marketplaceId: { type: String, default: 'EBAY_US' },

    // Product (item) location for listings published through this account.
    productLocationMode: { type: String, enum: ['merchant', 'custom'], default: 'merchant' },
    customPostalCode: { type: String, default: null },
    customCountryCode: { type: String, default: null },

    // Whether this is the user's currently "active" account for quick
    // actions (e.g. what the sidebar shows by default) - a UI convenience,
    // not a restriction, since most views show all accounts combined.
    isActive: { type: Boolean, default: false },

    // Last time we attempted an order sync for this account (periodic or
    // webhook-triggered) - used to respect the user's chosen sync interval.
    lastSyncAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One ELMS user should never connect the same eBay account twice.
ebayAccountSchema.index({ userId: 1, ebayUserId: 1 }, { unique: true });

module.exports = mongoose.model('EbayAccount', ebayAccountSchema);
