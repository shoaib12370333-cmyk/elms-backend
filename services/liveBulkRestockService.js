/**
 * Restocks many SOLD-OUT live listings at once: puts a fresh available quantity on eBay (services/ebayListingService.js
 * updateOfferQuantity - a few eBay calls per listing, see its comment; the offer write is per offer, so this runs a
 * modest number of listings at the same time), then moves
 * the listing back to 'published' in ELMS with that quantity and a soldQuantity of 0, so the next sale is counted
 * fresh against it (models/ordersModel.js markSoldIfOut).
 */
const listing = require('./ebayListingService');
const { mapPool } = require('./bulkEditService');

const PARALLEL = 5;
const RESTOCKABLE_STATUSES = ['sold'];

// Replaceable for tests.
const deps = {
  single: (refreshToken, offerId, quantity) => listing.updateOfferQuantity(refreshToken, offerId, quantity),
};

/**
 * @param {{ userId: string, ids: string[], quantity: number }} args quantity: the new total available on eBay (a positive integer)
 * @returns {Promise<{ results: Array<{ id, title, status: 'changed'|'skipped', reason? }>, summary: { changed: number, skipped: number } }>}
 */
async function bulkRestock({ userId, ids, quantity }, d) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    const err = new Error('Enter a whole number of at least 1.');
    err.statusCode = 400;
    throw err;
  }
  const found = await d.getListingsByIds(userId, ids);
  const tokens = new Map();
  const tokenFor = async (accountId) => {
    if (!tokens.has(accountId)) tokens.set(accountId, Promise.resolve(d.getRefreshToken(userId, accountId)).catch(() => null));
    return tokens.get(accountId);
  };

  const results = new Array(ids.length);
  await mapPool(ids, PARALLEL, async (id, index) => {
    const l = found.get(String(id));
    const title = l ? (l.title || l.sku || id) : null;
    const skip = (reason) => { results[index] = { id, title, status: 'skipped', reason }; };
    try {
      if (!l) return skip('Not found.');
      if (!RESTOCKABLE_STATUSES.includes(String(l.status || '').toLowerCase())) return skip('Only a sold-out listing can be restocked here.');
      if (!l.ebay_offer_id) return skip('This listing has no eBay offer to restock.');
      if (!l.ebay_account_id) return skip('No eBay account is connected to this listing.');
      const refreshToken = await tokenFor(l.ebay_account_id);
      if (!refreshToken) return skip('The connected eBay account is missing its connection. Reconnect it in Settings.');
      await deps.single(refreshToken, l.ebay_offer_id, qty);
      await d.restockListing(userId, id, qty);
      results[index] = { id, title, status: 'changed' };
    } catch (err) {
      console.warn(`[bulk-restock] ${(l && (l.sku || l.title)) || id}: ${err.message}`); // the page shows these, but the toast is gone in seconds
      skip(err.message || 'eBay did not accept the new quantity.');
    }
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { changed: count('changed'), skipped: count('skipped') } };
}

module.exports = { bulkRestock, deps, RESTOCKABLE_STATUSES };
