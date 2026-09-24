// Keeps the name of each connected eBay account up to date: the eBay username and the eBay Store name are read from eBay
// (see ebayIdentityService), remembered on the account, and only asked again when needed - never on every page load.
const EbayAccount = require('../models/schemas/EbayAccount');
const { decrypt } = require('./cryptoService');
const { fetchSellerIdentity } = require('./ebayIdentityService');
const { isPlaceholderUsername } = require('./accountLabel');

const RETRY_MS = 6 * 60 * 60 * 1000;        // an account whose name is still unknown: ask again after 6 hours
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // an account whose name is known: check again after 7 days (a store can be renamed)

const inflight = new Map();

/** Does this account need eBay to be asked who it is? (account = a serialized account or a plain document) */
function needsIdentity(acc, now = Date.now()) {
  const checkedAt = acc.identityCheckedAt ? new Date(acc.identityCheckedAt).getTime() : 0;
  if (!checkedAt) return true;
  const unknown = acc.storeName === null || acc.storeName === undefined || isPlaceholderUsername(acc.ebayUserId);
  return now - checkedAt > (unknown ? RETRY_MS : REFRESH_MS);
}

/**
 * Asks eBay who the account is and saves the answer: the Store name, and the real username in place of a placeholder.
 * Never throws (a failed lookup only postpones the next one). Returns the updated document, or null if it does not exist.
 */
async function refreshAccountIdentity(userId, accountId) {
  const key = String(accountId);
  if (inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    const doc = await EbayAccount.findOne({ _id: accountId, userId });
    if (!doc) return null;
    const update = { identityCheckedAt: new Date() };
    try {
      const identity = await fetchSellerIdentity(decrypt(doc.refreshTokenEncrypted), doc.marketplaceId);
      if (identity.storeName !== null) update.storeName = identity.storeName;
      if (identity.username && isPlaceholderUsername(doc.ebayUserId) && identity.username !== doc.ebayUserId) {
        const taken = await EbayAccount.exists({ userId, ebayUserId: identity.username, _id: { $ne: doc._id } });
        if (!taken) update.ebayUserId = identity.username;
      }
    } catch (err) {
      console.warn('[account-identity] ' + doc._id + ': ' + err.message);
    }
    return EbayAccount.findOneAndUpdate({ _id: doc._id, userId }, update, { new: true });
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/**
 * For a list of serialized accounts: looks up the ones that need it (in parallel, at most `timeoutMs` in total - the page
 * must not wait for eBay) and returns the ids that were refreshed, so the caller can read the list again.
 */
async function refreshStaleIdentities(userId, accounts, { timeoutMs = 6000 } = {}) {
  const stale = accounts.filter((a) => needsIdentity(a));
  if (!stale.length) return [];
  const work = Promise.allSettled(stale.map((a) => refreshAccountIdentity(userId, a.id)));
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  return stale.map((a) => a.id);
}

module.exports = { needsIdentity, refreshAccountIdentity, refreshStaleIdentities, RETRY_MS, REFRESH_MS };
