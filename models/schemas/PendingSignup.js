const mongoose = require('mongoose');

/**
 * A sign-up that is waiting for its email confirmation code. No account exists yet: the account (and its welcome credits) is made
 * only when the code that was mailed to the address is entered together with `pendingToken`, which only the browser that started the
 * sign-up holds (stored here as a hash). Someone who asks for a code for another person's address therefore cannot finish, and the
 * owner of the mailbox cannot be tricked into finishing somebody else's sign-up (a code alone is not enough).
 */
const pendingSignupSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  username: { type: String, required: true },
  passwordHash: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true },
  codeExpiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  sends: { type: Number, default: 1 },
  lastSentAt: { type: Date, required: true },
  referralCode: { type: String, default: null },
  affiliateCode: { type: String, default: null },
  ip: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// an unfinished sign-up disappears by itself
pendingSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);
