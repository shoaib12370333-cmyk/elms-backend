const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // Email is the one identifier shared between Google and email/password
    // login - it's what links a Google login and an email/password login
    // into the SAME account if they match, so credits/drafts/history are
    // never split across two accounts for the same person.
    email: { type: String, required: true, unique: true },

    // Present only for users who signed up with Google. Optional because a
    // user may register with just email/password and never use Google.
    googleId: { type: String, default: null, unique: true, sparse: true },

    // Present only for users who registered with email/password (hashed
    // with bcrypt - see services/passwordService.js - never stored in plain
    // text). Optional because a user may have only ever used Google.
    username: { type: String, default: null, unique: true, sparse: true },
    passwordHash: { type: String, default: null },

    name: { type: String, default: null },
    picture: { type: String, default: null },

    // Admin/access control. Admins have unlimited credits and can access
    // the Admin Panel to manage other users' credits and settings.
    role: { type: String, enum: ['admin', 'user'], default: 'user' },

    // Credit balance for Amazon API usage (import fetches + stock checks).
    // Assigned manually by an admin - see routes/admin.js.
    creditBalance: { type: Number, default: 0 },

    // How often (in days) this user's published listings should be checked
    // for Amazon stock. Set manually by an admin per user. The stock check
    // job only runs for a user once this many days have passed since their
    // lastStockCheckAt.
    stockCheckIntervalDays: { type: Number, default: 1 },
    lastStockCheckAt: { type: Date, default: null },

    // eBay account connection (per-user). The refresh token is encrypted
    // before it's stored - see services/cryptoService.js.
    ebayConnected: { type: Boolean, default: false },
    ebayUserId: { type: String, default: null }, // eBay's own username/ID for this seller
    ebayRefreshTokenEncrypted: { type: String, default: null },
    ebayRefreshTokenExpiresAt: { type: Date, default: null },

    // eBay business policy IDs, set by the user from their own eBay Seller Hub.
    // Required before this user can publish listings.
    ebayMerchantLocationKey: { type: String, default: null },
    ebayPaymentPolicyId: { type: String, default: null },
    ebayFulfillmentPolicyId: { type: String, default: null },
    ebayReturnPolicyId: { type: String, default: null },
    ebayMarketplaceId: { type: String, default: 'EBAY_US' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
