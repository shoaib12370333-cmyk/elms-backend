const Listing = require('../models/schemas/Listing');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { updateListingStats } = require('../models/listingsModel');
const { fetchItemTraffic } = require('./ebayStatsService');

/**
 * Reads views + watchers from eBay for published listings of one store and saves them.
 * Oldest-synced first, capped so one run can never burn through eBay's daily call allowance.
 * @returns {Promise<{ synced: number, failed: number, error: string|null }>}
 */
async function syncStatsForAccount(userId, accountId, { limit = 100, delayMs = 250 } = {}) {
  const refreshToken = await getEbayAccountRefreshToken(userId, accountId);
  if (!refreshToken) return { synced: 0, failed: 0, error: 'account_disconnected' };
  const listings = await Listing.find({ userId, ebayAccountId: accountId, status: 'published', ebayListingId: { $ne: null } })
    .sort({ statsSyncedAt: 1 })
    .limit(limit)
    .lean();
  let synced = 0;
  let failed = 0;
  let error = null;
  for (const l of listings) {
    try {
      const traffic = await fetchItemTraffic(refreshToken, l.ebayListingId, l.marketplaceId || 'EBAY_US');
      await updateListingStats(userId, String(l._id), traffic);
      synced += 1;
    } catch (err) {
      failed += 1;
      error = error || err.message;
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { synced, failed, error };
}

module.exports = { syncStatsForAccount };
