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

    // How many eBay accounts this user is allowed to connect at once - set
    // by an admin (see routes/admin.js). Connecting eBay accounts beyond
    // this limit is blocked with a friendly upgrade message.
    maxEbayAccounts: { type: Number, default: 1 },

    // Order sync mode: 'realtime' uses eBay's push notifications (webhook)
    // plus a safety-net poll every orderSyncIntervalMinutes in case a
    // webhook is ever missed; 'polling' relies entirely on the interval.
    // Costs differ (see config/actionCosts.js) since realtime needs a
    // standing webhook subscription kept alive daily.
    orderSyncMode: { type: String, enum: ['realtime', 'polling'], default: 'realtime' },
    orderSyncIntervalMinutes: { type: Number, default: 15 },
    lastOrderSyncCreditChargeAt: { type: Date, default: null },

    // Unique credential for the ELMS browser extension. The plaintext key is
    // never stored; it is encrypted at rest and its SHA-256 hash is used for lookup.
    extensionKeyEncrypted: { type: String, default: null },
    extensionKeyHash: { type: String, default: null, unique: true, sparse: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
