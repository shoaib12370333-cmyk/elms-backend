const User = require('./schemas/User');
const { encrypt, decrypt } = require('../services/cryptoService');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('../services/passwordService');
const { getSettings } = require('./settingsModel');

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
      // Link this Google identity to the existing account - this is NOT a
      // new account, so no welcome bonus here.
      user.googleId = googleId;
      user.name = user.name || name;
      user.picture = user.picture || picture;
      await user.save();
    } else {
      // A genuinely brand-new account - apply the welcome bonus if enabled.
      const creditBalance = await getWelcomeBonusAmount();
      user = await User.create({ googleId, email, name, picture, creditBalance });
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
 * Returns the welcome bonus credit amount to apply to a new account, or 0
 * if the welcome bonus is currently disabled.
 */
async function getWelcomeBonusAmount() {
  const settings = await getSettings();
  return settings.welcomeBonusEnabled ? settings.welcomeBonusCredits : 0;
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
    // This email exists from a Google login - adding a password to it is
    // NOT a new account, so no welcome bonus here.
    user.username = username;
    user.passwordHash = passwordHash;
    await user.save();
  } else {
    // A genuinely brand-new account - apply the welcome bonus if enabled.
    const creditBalance = await getWelcomeBonusAmount();
    user = await User.create({ username, email, passwordHash, name: username, creditBalance });
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
 * COMPATIBILITY LAYER (Stage 1 of multi-account support):
 *
 * These functions used to store a single eBay connection directly on the
 * User document. That data now lives in the separate EbayAccount
 * collection (see models/ebayAccountsModel.js), since a user can have
 * multiple eBay accounts.
 *
 * The functions below delegate to that user's "active" eBay account so
 * existing callers (listOnEbay, orders, the background jobs) keep working
 * unchanged for now. Stage 2 will update those callers to work with a
 * specific eBay account ID instead of always using "the active one."
 */
const ebayAccountsModel = require('./ebayAccountsModel');

async function getEbayRefreshToken(userId) {
  const active = await ebayAccountsModel.getActiveEbayAccount(userId);
  if (!active) return null;
  return ebayAccountsModel.getEbayAccountRefreshToken(userId, active.id);
}

async function disconnectEbay(userId) {
  const active = await ebayAccountsModel.getActiveEbayAccount(userId);
  if (!active) return null;
  await ebayAccountsModel.removeEbayAccount(userId, active.id);
  return getUserById(userId);
}

async function saveSellerSettings(userId, updates) {
  const active = await ebayAccountsModel.getActiveEbayAccount(userId);
  if (!active) return null;
  return ebayAccountsModel.updateEbayAccountSettings(userId, active.id, updates);
}

async function getSellerSettings(userId) {
  return ebayAccountsModel.getActiveEbayAccount(userId);
}

/**
 * Checks whether a user has at least one credit available, WITHOUT spending
 * it. Admins always pass (unlimited credits).
 */
async function hasCredits(userId, amount = 1) {
  if (amount <= 0) return true; // free action - always allowed
  const user = await User.findById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.creditBalance >= amount;
}

/**
 * Deducts one credit for an Amazon API call (import fetch or stock check).
 * Admins are never charged (unlimited credits). Returns false if the user
 * has no credits left, so the caller can block the action.
 *
 * IMPORTANT: this is done as a single atomic MongoDB operation (the
 * balance check and the decrement happen together, in one database
 * command) rather than "read the balance, then write it back" - the old
 * approach had a race condition where two simultaneous requests could
 * both read the same balance (e.g. 1 credit left), both pass the "is it >
 * 0" check, and both deduct, leaving the balance at -1 and effectively
 * granting one free extra use. The atomic update below makes that
 * impossible: MongoDB only applies the decrement if the balance is still
 * above zero at the exact moment it executes the write.
 */
/**
 * Deducts credits for a billable action (import, publish, stock check,
 * etc). Admins are never charged (unlimited credits). A cost of 0 means a
 * free action - always succeeds without touching the balance, so free
 * actions never need special-casing at the call site.
 *
 * Returns false only if a non-admin user doesn't have enough credits for
 * a non-zero cost, so the caller can block the action.
 *
 * IMPORTANT: this is done as a single atomic MongoDB operation (the
 * balance check and the decrement happen together, in one database
 * command) rather than "read the balance, then write it back" - the old
 * approach had a race condition where two simultaneous requests could
 * both read the same balance (e.g. 1 credit left), both pass the "is it >
 * 0" check, and both deduct, leaving the balance at -1 and effectively
 * granting one free extra use. The atomic update below makes that
 * impossible: MongoDB only applies the decrement if the balance is still
 * sufficient at the exact moment it executes the write.
 */
async function spendCredit(userId, amount = 1) {
  if (amount <= 0) return true; // free action - nothing to charge

  const user = await User.findById(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;

  const updated = await User.findOneAndUpdate(
    { _id: userId, creditBalance: { $gte: amount } },
    { $inc: { creditBalance: -amount } },
    { new: true }
  );

  return !!updated;
}

/**
 * Refunds credits to a user after a billable action failed partway
 * through (e.g. a credit was spent for an Amazon fetch, but the
 * subsequent eBay publish failed) - so a failed action never permanently
 * costs the user credits they didn't get value from. A no-op for admins
 * (who were never charged) and for a zero/negative amount.
 */
async function refundCredit(userId, amount = 1) {
  if (amount <= 0) return true;

  const user = await User.findById(userId);
  if (!user || user.role === 'admin') return true;

  await User.updateOne({ _id: userId }, { $inc: { creditBalance: amount } });
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
 * Admin-only: sets how many eBay accounts a user is allowed to connect.
 */
async function setMaxEbayAccounts(userId, max) {
  const user = await User.findByIdAndUpdate(userId, { maxEbayAccounts: max }, { new: true });
  return user ? serialize(user) : null;
}

/**
 * Lets a user choose their own order-sync mode (realtime vs polling) and
 * interval - see jobs/orderSync.js for how these are applied.
 */
async function setOrderSyncSettings(userId, { orderSyncMode, orderSyncIntervalMinutes }) {
  const update = {};
  if (orderSyncMode !== undefined) update.orderSyncMode = orderSyncMode;
  if (orderSyncIntervalMinutes !== undefined) update.orderSyncIntervalMinutes = orderSyncIntervalMinutes;

  const user = await User.findByIdAndUpdate(userId, update, { new: true });
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
 * last check (or who has never been checked at all), AND who has at least
 * one connected eBay account. Used by the daily stock-check job - each
 * returned user is due for a check right now.
 */
async function listUsersDueForStockCheck() {
  const EbayAccount = require('./schemas/EbayAccount');
  const connectedUserIds = await EbayAccount.distinct('userId');
  const users = await User.find({ _id: { $in: connectedUserIds } });
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
/**
 * Returns the user's persistent ELMS extension key, creating it on first use.
 * The key can be pasted into the browser extension from any device.
 */
async function getOrCreateExtensionKey(userId) {
  let user = await User.findById(userId);
  if (!user) return null;

  if (user.extensionKeyEncrypted && user.extensionKeyHash) {
    return decrypt(user.extensionKeyEncrypted);
  }

  const plainKey = `elms_ext_${crypto.randomBytes(24).toString('base64url')}`;
  user.extensionKeyEncrypted = encrypt(plainKey);
  user.extensionKeyHash = crypto.createHash('sha256').update(plainKey).digest('hex');
  await user.save();
  return plainKey;
}

/** Regenerates the extension key and invalidates the old one immediately. */
async function regenerateExtensionKey(userId) {
  const user = await User.findById(userId);
  if (!user) return null;

  const plainKey = `elms_ext_${crypto.randomBytes(24).toString('base64url')}`;
  user.extensionKeyEncrypted = encrypt(plainKey);
  user.extensionKeyHash = crypto.createHash('sha256').update(plainKey).digest('hex');
  await user.save();
  return plainKey;
}

/** Finds a user from an extension key without ever storing the key plaintext as a lookup value. */
async function getUserByExtensionKey(plainKey) {
  const value = String(plainKey || '').trim();
  if (!/^elms_ext_[A-Za-z0-9_-]{32}$/.test(value)) return null;
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return User.findOne({ extensionKeyHash: hash });
}

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
    maxEbayAccounts: obj.maxEbayAccounts ?? 1,
    orderSyncMode: obj.orderSyncMode || 'realtime',
    orderSyncIntervalMinutes: obj.orderSyncIntervalMinutes ?? 15,
    createdAt: obj.createdAt,
  };
}

module.exports = {
  findOrCreateUser,
  registerWithPassword,
  loginWithPassword,
  getUserById,
  getEbayRefreshToken,
  disconnectEbay,
  saveSellerSettings,
  getSellerSettings,
  hasCredits,
  spendCredit,
  refundCredit,
  addCredits,
  setCreditBalance,
  setStockCheckInterval,
  setMaxEbayAccounts,
  setOrderSyncSettings,
  getOrCreateExtensionKey,
  regenerateExtensionKey,
  getUserByExtensionKey,
  listAllUsers,
  listUsersDueForStockCheck,
  markStockCheckRan,
};
