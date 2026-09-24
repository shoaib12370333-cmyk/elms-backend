const EbayAccount = require('./schemas/EbayAccount');
const User = require('./schemas/User');
const { encrypt, decrypt } = require('../services/cryptoService');
const { accountLabel, publicUsername, isPlaceholderUsername } = require('../services/accountLabel');

/** The next free "Store N" number of a user (numbers are never reused after a store is removed). */
async function nextStoreNumber(userId) {
  const top = await EbayAccount.findOne({ userId, storeNumber: { $ne: null } }).sort({ storeNumber: -1 }).select('storeNumber').lean();
  return (top?.storeNumber || 0) + 1;
}

/**
 * Returns how many eBay accounts a user currently has connected, and how
 * many they're allowed (set by an admin) - used to enforce the connect limit.
 */
async function getAccountLimitStatus(userId) {
  const [count, user] = await Promise.all([
    EbayAccount.countDocuments({ userId }),
    User.findById(userId),
  ]);
  return { connected: count, max: user?.maxEbayAccounts ?? 1 };
}

/**
 * Saves a newly connected eBay account for a user, enforcing their
 * admin-set connection limit first.
 *
 * Throws a friendly, actionable error if the user is already at their limit.
 */
async function addEbayAccount(userId, { ebayUserId, refreshToken, expiresAt, marketplaceId = 'EBAY_US', storeName = null, identityCheckedAt = null }) {
  const { connected, max } = await getAccountLimitStatus(userId);

  // If this exact eBay account is already connected, this is a
  // reconnect/refresh, not a new connection - don't count it against the limit.
  let existing = await EbayAccount.findOne({ userId, ebayUserId });

  // A store that was connected while eBay gave no username is saved under a stand-in name. Connecting it again, now with the real
  // username, is the same store: it takes its place (with all its listings and orders) instead of becoming a second one.
  if (!existing && !isPlaceholderUsername(ebayUserId)) {
    const stand = (await EbayAccount.find({ userId, marketplaceId: marketplaceId || 'EBAY_US' })).filter((a) => isPlaceholderUsername(a.ebayUserId));
    if (stand.length === 1) { existing = stand[0]; existing.ebayUserId = ebayUserId; }
  }

  if (!existing && connected >= max) {
    const err = new Error(
      `Your account currently has ${max} eBay account${max === 1 ? '' : 's'} connected (your limit). ` +
      `If you want to connect more accounts, kindly upgrade your subscription. ` +
      `If you have already upgraded your subscription, kindly contact our support team.`
    );
    err.statusCode = 403;
    throw err;
  }

  const refreshTokenEncrypted = encrypt(refreshToken);

  if (existing) {
    existing.refreshTokenEncrypted = refreshTokenEncrypted;
    existing.refreshTokenExpiresAt = expiresAt || null;
    existing.marketplaceId = marketplaceId || existing.marketplaceId || 'EBAY_US';
    if (storeName !== null) existing.storeName = storeName;
    if (identityCheckedAt) existing.identityCheckedAt = identityCheckedAt;
    if (!existing.storeNumber) existing.storeNumber = await nextStoreNumber(userId);
    await existing.save();
    return serialize(existing);
  }

  // The first account a user connects becomes their default "active" one.
  const isFirstAccount = connected === 0;
  const doc = await EbayAccount.create({
    userId,
    ebayUserId,
    refreshTokenEncrypted,
    refreshTokenExpiresAt: expiresAt || null,
    marketplaceId: marketplaceId || 'EBAY_US',
    isActive: isFirstAccount,
    storeName,
    identityCheckedAt,
    storeNumber: await nextStoreNumber(userId),
  });

  return serialize(doc);
}

/**
 * Returns all of a user's connected eBay accounts (for the sidebar
 * dropdown, Settings page, etc).
 */
async function listEbayAccounts(userId) {
  const docs = await EbayAccount.find({ userId }).sort({ createdAt: 1 });
  // Accounts connected before "Store N" existed get their number now, in the order they were connected.
  if (docs.some((d) => !d.storeNumber)) {
    let n = Math.max(0, ...docs.map((d) => d.storeNumber || 0));
    for (const d of docs) {
      if (d.storeNumber) continue;
      n += 1;
      d.storeNumber = n;
      await EbayAccount.updateOne({ _id: d._id }, { storeNumber: n });
    }
  }
  return docs.map(serialize);
}

/**
 * Returns one specific eBay account (by its ID), scoped to the given user
 * so one user can never access another's account.
 */
async function getEbayAccountById(userId, accountId) {
  const doc = await EbayAccount.findOne({ _id: accountId, userId });
  return doc ? serialize(doc) : null;
}

/**
 * Returns the decrypted refresh token for a specific eBay account - used
 * whenever we need to actually call the eBay API on that account's behalf.
 */
async function getEbayAccountRefreshToken(userId, accountId) {
  const doc = await EbayAccount.findOne({ _id: accountId, userId });
  if (!doc) return null;
  return decrypt(doc.refreshTokenEncrypted);
}

/**
 * Returns the user's currently "active" eBay account (for quick actions
 * that need a single default, like the sidebar widget) - falls back to
 * the first connected account if none is marked active.
 */
async function getActiveEbayAccount(userId) {
  let doc = await EbayAccount.findOne({ userId, isActive: true });
  if (!doc) {
    doc = await EbayAccount.findOne({ userId }).sort({ createdAt: 1 });
  }
  return doc ? serialize(doc) : null;
}

/**
 * Sets which of a user's eBay accounts is "active" (unsets any others).
 */
async function setActiveEbayAccount(userId, accountId) {
  const account = await EbayAccount.findOne({ _id: accountId, userId });
  if (!account) return null;

  await EbayAccount.updateMany({ userId }, { isActive: false });
  account.isActive = true;
  await account.save();
  return serialize(account);
}

async function purgeStoreData(userId, accountId) {
  const Listing = require('./schemas/Listing');
  const Order = require('./schemas/Order');
  const Conversation = require('./schemas/Conversation');
  const Message = require('./schemas/Message');
  const Import = require('./schemas/Import');
  const SystemNotification = require('./schemas/SystemNotification');
  const listings = await Listing.find({ userId, ebayAccountId: accountId }, { _id: 1, importId: 1 }).lean();
  const listingIds = listings.map((l) => l._id);
  const importIds = listings.map((l) => l.importId).filter(Boolean);
  await Promise.all([
    Listing.deleteMany({ userId, ebayAccountId: accountId }),
    Order.deleteMany({ userId, ebayAccountId: accountId }),
    Message.deleteMany({ userId, ebayAccountId: accountId }),
    Conversation.deleteMany({ userId, ebayAccountId: accountId }),
    Import.deleteMany({ userId, $or: [{ ebayAccountId: accountId }, { _id: { $in: importIds } }] }),
    SystemNotification.deleteMany({ userId, $or: [{ ebayAccountId: accountId }, { listingId: { $in: listingIds } }] }),
  ]);
}

/**
 * Disconnects (removes) one of a user's eBay accounts and deletes the data ELMS kept for it.
 */
async function removeEbayAccount(userId, accountId) {
  const doc = await EbayAccount.findOneAndDelete({ _id: accountId, userId });
  if (!doc) return false;

  // Everything ELMS stored for this store goes with it (the live eBay listings
  // themselves are untouched): listings/drafts, orders, messages, notifications, imports.
  await purgeStoreData(userId, doc._id);

  // If the removed account was the active one, promote another connected
  // account (if any) to active so the sidebar always has a sensible default.
  if (doc.isActive) {
    const next = await EbayAccount.findOne({ userId }).sort({ createdAt: 1 });
    if (next) {
      next.isActive = true;
      await next.save();
    }
  }

  return true;
}

/**
 * Updates one eBay account's business policy / product location settings.
 */
async function updateEbayAccountSettings(userId, accountId, updates) {
  const allowedFields = [
    'merchantLocationKey', 'paymentPolicyId', 'fulfillmentPolicyId', 'returnPolicyId',
    'marketplaceId', 'productLocationMode', 'customPostalCode', 'customCountryCode',
  ];
  const update = {};
  allowedFields.forEach((field) => {
    if (updates[field] !== undefined) update[field] = updates[field];
  });

  const doc = await EbayAccount.findOneAndUpdate({ _id: accountId, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

async function updateEbayAccountDisplayName(userId, accountId, displayName) {
  const clean = String(displayName || '').trim();
  const doc = await EbayAccount.findOneAndUpdate(
    { _id: accountId, userId },
    { displayName: clean || null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId.toString(),
    ebayUserId: obj.ebayUserId,
    // The real eBay username (null when eBay never gave one - the stand-in name is never shown), the eBay Store name
    // (null = not looked up yet, '' = the seller has no store) and the one name the UI shows for the account.
    username: publicUsername(obj.ebayUserId),
    storeName: obj.storeName === undefined ? null : obj.storeName,
    storeNumber: obj.storeNumber || null,
    identityCheckedAt: obj.identityCheckedAt || null,
    label: accountLabel(obj),
    displayName: obj.displayName || '',
    merchantLocationKey: obj.merchantLocationKey,
    paymentPolicyId: obj.paymentPolicyId,
    fulfillmentPolicyId: obj.fulfillmentPolicyId,
    returnPolicyId: obj.returnPolicyId,
    marketplaceId: obj.marketplaceId || 'EBAY_US',
    productLocationMode: obj.productLocationMode || 'merchant',
    customPostalCode: obj.customPostalCode,
    customCountryCode: obj.customCountryCode,
    isActive: obj.isActive,
    createdAt: obj.createdAt,
  };
}

module.exports = {
  getAccountLimitStatus,
  addEbayAccount,
  listEbayAccounts,
  getEbayAccountById,
  getEbayAccountRefreshToken,
  getActiveEbayAccount,
  setActiveEbayAccount,
  removeEbayAccount,
  updateEbayAccountSettings,
  updateEbayAccountDisplayName,
};
