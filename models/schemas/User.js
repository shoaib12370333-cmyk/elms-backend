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
    // true while the password was set at sign-up (/register) and the person never proved they own the mailbox. A Google sign-in
    // (which proves it) or a password reset with the code mailed to them clears it; until then a Google sign-in on the same
    // address removes that password, because a stranger may have registered the address first. Missing = an account from before
    // this existed (its password is trusted as it is).
    unverifiedPassword: { type: Boolean, default: undefined },

    name: { type: String, default: null },
    picture: { type: String, default: null },

    // Admin/access control. Admins have unlimited credits and can access
    // the Admin Panel to manage other users' credits and settings.
    role: { type: String, enum: ['admin', 'user'], default: 'user' },

    // Credit balance for Amazon API usage (import fetches + stock checks).
    // Assigned manually by an admin - see routes/admin.js.
    creditBalance: { type: Number, default: 0 },
    // The welcome credits this account was given when it was created (what the welcome popup shows; not set when it got none),
    // and when the user closed that popup (it is shown once, on any device).
    welcomeCredits: { type: Number, default: undefined },
    welcomePopupSeenAt: { type: Date, default: null },
    // Set when the account was made by entering the confirmation code mailed to the address (accounts from before have none).
    emailVerifiedAt: { type: Date, default: undefined },
    emailKey: { type: String, default: null, index: true }, // the mailbox with dots / +tags removed (services/signupBonusGuard.js)

    // Messages page: how ELMS answers new buyer messages. off = never, draft = AI writes a draft for you
    // to review, auto = AI also sends it (only for simple, low-risk messages).
    // Set by an admin (Admin -> Users / Security): the account cannot sign in or use the site. The reason is shown to the
    // person, who can appeal from the blocked screen.
    // The user's own VeRO words (Settings -> VeRO): the words flagged in their drafts and listings.
    veroWords: { type: [String], default: [] },
    // Name of the plan the user bought last (shown under their name). null = free plan.
    planName: { type: String, default: null },
    // A monthly / yearly plan runs until planExpiresAt; then the credits end and the eBay-account limit goes back to what it was
    // before the plan (planPrevMaxEbayAccounts). null = no term (free, or a pack bought before terms existed).
    planExpiresAt: { type: Date, default: null },
    planTerm: { type: String, enum: ['monthly', 'yearly', null], default: null },
    planPrevMaxEbayAccounts: { type: Number, default: null },
    // Ids of the payments already given to this person (services/planGrantService.js). The credits and the payment id are written by
    // one update, so a payment that is reported twice is credited once. Only the newest few are kept; not sent to the site.
    processedPayments: { type: [String], default: undefined, select: false },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },
    suspendedNote: { type: String, default: null }, // private, for the admins
    // Security: tokens issued before this moment are rejected ("log out everywhere"), and the new-device email switch.
    sessionsValidFrom: { type: Date, default: null },
    notifyNewDevice: { type: Boolean, default: true },
    // Announcement mails (product news). Users can switch them off with the unsubscribe link in every mail.
    marketingOptOut: { type: Boolean, default: false },
    aiReplyMode: { type: String, enum: ['off', 'draft', 'auto'], default: 'off' },
    aiReplyEnabledAt: { type: Date, default: null },

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
    // Real-time is free; only 'polling' is charged a daily fee (see
    // config/actionCosts.js).
    orderSyncMode: { type: String, enum: ['realtime', 'polling'], default: 'realtime' },
    orderSyncIntervalMinutes: { type: Number, default: 15 },
    lastOrderSyncCreditChargeAt: { type: Date, default: null },

    // Auto Order workflow. The buyer-account automation itself is intentionally
    // not enabled by this backend; Semi-Auto is the usable mode today.
    // Full-Auto can be selected only as a saved preference and is blocked at
    // execution time until a supported buyer-account adapter is connected.
    autoOrderMode: { type: String, enum: ['disabled', 'semi_auto', 'full_auto'], default: 'disabled' },
    fullAutoConfirmedAt: { type: Date, default: null },

    // Unique credential for the ELMS browser extension. The plaintext key is
    // never stored; it is encrypted at rest and its SHA-256 hash is used for lookup.
    extensionKeyEncrypted: { type: String, default: null },
    // No default: users without a key must have the field MISSING, not null. A unique index treats
    // every explicit null as the same value, so `default: null` made the second signup ever fail
    // with E11000 (a sparse index still indexes explicit nulls).
    extensionKeyHash: { type: String, default: undefined },

    // Referral programme (services/referralService.js). The code is what a friend types (or finds in ?ref=) when signing up.
    // No default, like extensionKeyHash: accounts without a code must have the field MISSING so the unique index ignores them.
    referralCode: { type: String, default: undefined },
    // The affiliate whose link this person signed up through: they earn a percentage of this person's payments (services/affiliateService.js).
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', default: undefined, index: true },
    // Set by an admin for this person as a referrer: the discount THEIR friends get (null = the default from Admin -> Referrals),
    // the credits they earn when a friend buys (null = the default), and a switch that stops their code from working.
    referralDiscountPercent: { type: Number, default: null },
    referralRewardCredits: { type: Number, default: null },
    referralBlocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique only among users that actually have a key.
userSchema.index({ extensionKeyHash: 1 }, { unique: true, partialFilterExpression: { extensionKeyHash: { $type: 'string' } } });
userSchema.index({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
