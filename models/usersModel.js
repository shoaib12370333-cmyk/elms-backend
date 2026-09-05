const User = require('./schemas/User');
const { encrypt, decrypt } = require('../services/cryptoService');
const { hashPassword, verifyPassword } = require('../services/passwordService');

/**
 * Finds an existing user by their Google ID, or creates a new one.
 * Called every time someone signs in with Google.
 *
 * IMPORTANT: if a user already registered with email/password using this
 * same email, we link this Google login to THAT account (by email) instead
 * of creating a second, separate account - so their credits, drafts, and
 * history are never split across two accounts just because they used a
 * different login method.
 */
async function findOrCreateUser({ googleId, email, name, picture }) {
  let user = await User.findOne({ googleId });

  if (!user) {
    // No account with this googleId yet - check if this email already has
    // an account (e.g. from email/password registration) before creating a new one.
    user = await User.findOne({ email });

    if (user) {
      // Link this Google identity to the existing account.
      user.googleId = googleId;
      user.name = user.name || name;
      user.picture = user.picture || picture;
      await user.save();
    } else {
      user = await User.create({ googleId, email, name, picture });
    }
  } else {
    // Keep the profile info fresh (name/picture can change on Google's side).
    user.email = email;
    user.name = name;
    user.picture = picture;
    await user.save();
  }

  return serialize(user);
}

/**
 * Registers a new user with username/email/password. If an account with
 * this email already exists (e.g. from a previous Google login), the
 * password is added to THAT account instead of creating a duplicate - so
 * the person ends up with one account they can log into either way.
 *
 * Throws if the username is already taken by someone else, or if an
 * existing account with this email already has a password set.
 */
async function registerWithPassword({ username, email, password }) {
  const existingUsername = await User.findOne({ username });
  if (existingUsername) {
    const err = new Error('That username is already taken.');
    err.statusCode = 409;
    throw err;
  }

  const passwordHash = await hashPassword(password);
  let user = await User.findOne({ email });

  if (user) {
    if (user.passwordHash) {
      const err = new Error('An account with this email already has a password set. Please log in instead.');
      err.statusCode = 409;
      throw err;
    }
    // This email exists from a Google login - add password/username to link them.
    user.username = username;
    user.passwordHash = passwordHash;
    await user.save();
  } else {
    user = await User.create({ username, email, passwordHash, name: username });
  }

  return serialize(user);
}

/**
 * Verifies email/password login credentials. Returns the user on success,
 * or throws a generic "invalid credentials" error on failure (never reveals
 * whether the email or the password was the one that was wrong).
 */
async function loginWithPassword({ email, password }) {
  const user = await User.findOne({ email });

  const invalidError = () => {
    const err = new Error('Invalid email or password.');
    err.statusCode = 401;
    return err;
  };

  if (!user || !user.passwordHash) {
    throw invalidError();
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    throw invalidError();
  }

  return serialize(user);
}

async function getUserById(id) {
  const user = await User.findById(id);
  return user ? serialize(user) : null;
}

/**
 * Saves a user's eBay refresh token (encrypted) after they complete the
 * eBay "Connect Account" OAuth flow.
 */
async function saveEbayConnection(userId, { refreshToken, ebayUserId, expiresAt }) {
  const encrypted = encrypt(refreshToken);

  const user = await User.findByIdAndUpdate(
    userId,
    {
      ebayConnected: true,
      ebayUserId: ebayUserId || null,
      ebayRefreshTokenEncrypted: encrypted,
      ebayRefreshTokenExpiresAt: expiresAt || null,
    },
    { new: true }
  );

  return user ? serialize(user) : null;
}

/**
 * Returns a user's decrypted eBay refresh token, for making eBay API calls
 * on their behalf. Returns null if they haven't connected eBay yet.
 */
async function getEbayRefreshToken(userId) {
  const user = await User.findById(userId);
  if (!user || !user.ebayRefreshTokenEncrypted) return null;
  return decrypt(user.ebayRefreshTokenEncrypted);
}

async function disconnectEbay(userId) {
  const user = await User.findByIdAndUpdate(
    userId,
    {
      ebayConnected: false,
      ebayUserId: null,
      ebayRefreshTokenEncrypted: null,
      ebayRefreshTokenExpiresAt: null,
    },
    { new: true }
  );
  return user ? serialize(user) : null;
}

/**
 * Saves a user's eBay business policy settings (from their own Seller Hub).
 * These are required before the user can publish a listing.
 */
async function saveSellerSettings(userId, { merchantLocationKey, paymentPolicyId, fulfillmentPolicyId, returnPolicyId, marketplaceId }) {
  const update = {};
  if (merchantLocationKey !== undefined) update.ebayMerchantLocationKey = merchantLocationKey;
  if (paymentPolicyId !== undefined) update.ebayPaymentPolicyId = paymentPolicyId;
  if (fulfillmentPolicyId !== undefined) update.ebayFulfillmentPolicyId = fulfillmentPolicyId;
  if (returnPolicyId !== undefined) update.ebayReturnPolicyId = returnPolicyId;
  if (marketplaceId !== undefined) update.ebayMarketplaceId = marketplaceId;

  const user = await User.findByIdAndUpdate(userId, update, { new: true });
  return user ? serialize(user) : null;
}

/**
 * Returns a user's eBay seller settings in the shape ebayListingService expects.
 */
async function getSellerSettings(userId) {
  const user = await User.findById(userId);
  if (!user) return null;

  return {
    merchantLocationKey: user.ebayMerchantLocationKey,
    paymentPolicyId: user.ebayPaymentPolicyId,
    fulfillmentPolicyId: user.ebayFulfillmentPolicyId,
    returnPolicyId: user.ebayReturnPolicyId,
    marketplaceId: user.ebayMarketplaceId || 'EBAY_US',
  };
}

/**
 * Checks whether a user has at least one credit available, WITHOUT spending
 * it. Admins always pass (unlimited credits).
 */
async function hasCredits(userId) {
  const user = await User.findById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.creditBalance > 0;
}

/**
 * Deducts one credit for an Amazon API call (import fetch or stock check).
 * Admins are never charged (unlimited credits). Returns false if the user
 * has no credits left, so the caller can block the action.
 */
async function spendCredit(userId) {
  const user = await User.findById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;

  if (user.creditBalance <= 0) return false;

  user.creditBalance -= 1;
  await user.save();
  return true;
}

/**
 * Adds credits to a user's balance - used after a successful purchase
 * (Paddle webhook), NOT by users directly.
 */
async function addCredits(userId, amount) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { creditBalance: amount } },
    { new: true }
  );
  return user ? serialize(user) : null;
}

/**
 * Admin-only: sets a user's credit balance directly (e.g. after they pay
 * for more credits outside the app).
 */
async function setCreditBalance(userId, creditBalance) {
  const user = await User.findByIdAndUpdate(userId, { creditBalance }, { new: true });
  return user ? serialize(user) : null;
}

/**
 * Admin-only: sets how many days must pass between this user's automatic
 * stock checks.
 */
async function setStockCheckInterval(userId, days) {
  const user = await User.findByIdAndUpdate(userId, { stockCheckIntervalDays: days }, { new: true });
  return user ? serialize(user) : null;
}

/**
 * Admin-only: returns every user (for the Admin Panel user list).
 */
async function listAllUsers() {
  const users = await User.find().sort({ createdAt: -1 });
  return users.map(serialize);
}

/**
 * Returns every user whose stock-check interval has elapsed since their
 * last check (or who has never been checked at all). Used by the daily
 * stock-check job - each returned user is due for a check right now.
 */
async function listUsersDueForStockCheck() {
  const users = await User.find({ ebayConnected: true });
  const now = Date.now();

  return users
    .filter((user) => {
      if (!user.lastStockCheckAt) return true; // never checked -> due now
      const intervalMs = (user.stockCheckIntervalDays || 1) * 24 * 60 * 60 * 1000;
      return now - user.lastStockCheckAt.getTime() >= intervalMs;
    })
    .map(serialize);
}

/**
 * Marks that a user's stock check just ran, so the next one is due after
 * their configured interval.
 */
async function markStockCheckRan(userId) {
  await User.findByIdAndUpdate(userId, { lastStockCheckAt: new Date() });
}

/**
 * Converts a Mongoose user document into the plain shape the rest of the
 * app uses. Never includes the encrypted refresh token itself.
 */
function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    googleId: obj.googleId,
    username: obj.username,
    email: obj.email,
    name: obj.name,
    picture: obj.picture,
    role: obj.role || 'user',
    creditBalance: obj.creditBalance ?? 0,
    stockCheckIntervalDays: obj.stockCheckIntervalDays ?? 1,
    lastStockCheckAt: obj.lastStockCheckAt || null,
    ebayConnected: obj.ebayConnected,
    ebayUserId: obj.ebayUserId,
    ebaySellerSettings: {
      merchantLocationKey: obj.ebayMerchantLocationKey,
      paymentPolicyId: obj.ebayPaymentPolicyId,
      fulfillmentPolicyId: obj.ebayFulfillmentPolicyId,
      returnPolicyId: obj.ebayReturnPolicyId,
      marketplaceId: obj.ebayMarketplaceId || 'EBAY_US',
    },
    createdAt: obj.createdAt,
  };
}

module.exports = {
  findOrCreateUser,
  registerWithPassword,
  loginWithPassword,
  getUserById,
  saveEbayConnection,
  getEbayRefreshToken,
  disconnectEbay,
  saveSellerSettings,
  getSellerSettings,
  hasCredits,
  spendCredit,
  addCredits,
  setCreditBalance,
  setStockCheckInterval,
  listAllUsers,
  listUsersDueForStockCheck,
  markStockCheckRan,
};
