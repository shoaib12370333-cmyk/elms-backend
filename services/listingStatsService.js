const Listing = require('../models/schemas/Listing');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { fetchActiveListingStats, fetchItemTraffic } = require('./ebayStatsService');
const { reserve } = require('./ebayCallBudget');

const MAX_PAGES = 10;             // 200 listings per page: a store of 2,000 live listings is read in full
const VIEWS_FALLBACK_PER_RUN = 3; // listings whose view count is read one by one when the bulk answer has none

/**
 * Reads watchers (and views) from eBay for the published listings of ONE store and saves them.
 *
 * The whole store is read with GetMyeBaySelling, 200 listings per eBay call, instead of one GetItem call per listing:
 * eBay allows only 5,000 Trading calls a day for the whole application, so ten big stores read listing by listing would
 * use that up many times over (see services/ebayCallBudget.js). Every call is taken from that daily budget first and the
 * run stops quietly when the budget is used up.
 *
 * If the bulk answer carries no view count (HitCount), views are refreshed a few listings at a time with GetItem
 * (oldest first, at most `viewsFallback` per run), so they keep moving without spending the day's allowance.
 *
 * @param {{ minAgeMs?: number, viewsFallback?: number, maxPages?: number }} [opts]
 *   minAgeMs: skip eBay when this store was refreshed less than that long ago (the page-open / button path)
 * @returns {Promise<{ synced: number, failed: number, error: string|null, calls: number, fresh: boolean, limited: boolean, viewsInBulk: boolean }>}
 */
async function syncStatsForAccount(userId, accountId, { minAgeMs = 0, viewsFallback = VIEWS_FALLBACK_PER_RUN, maxPages = MAX_PAGES } = {}) {
  const result = { synced: 0, failed: 0, error: null, calls: 0, fresh: false, limited: false, viewsInBulk: false };
  const refreshToken = await getEbayAccountRefreshToken(userId, accountId);
  if (!refreshToken) return { ...result, error: 'account_disconnected' };

  const listings = await Listing.find({ userId, ebayAccountId: accountId, status: 'published', ebayListingId: { $ne: null } })
    .select('ebayListingId marketplaceId views statsSyncedAt viewsSyncedAt')
    .lean();
  if (!listings.length) return result;

  if (minAgeMs > 0) {
    const newest = listings.reduce((max, l) => Math.max(max, l.statsSyncedAt ? new Date(l.statsSyncedAt).getTime() : 0), 0);
    if (newest && Date.now() - newest < minAgeMs) return { ...result, fresh: true };
  }

  // Which listing belongs to which eBay item id, grouped by the marketplace they were published on.
  const byItem = new Map(listings.map((l) => [String(l.ebayListingId).replace(/[^0-9]/g, ''), l]));
  const marketplaces = [...new Set(listings.map((l) => l.marketplaceId || 'EBAY_US'))];
  const found = new Map(); // item id -> { watchers, views }

  for (const marketplaceId of marketplaces) {
    if (found.size >= byItem.size) break; // everything was already found on an earlier marketplace
    for (let page = 1; page <= maxPages; page += 1) {
      if (!(await reserve('stats', 1))) { result.limited = true; break; }
      result.calls += 1;
      let answer;
      try {
        answer = await fetchActiveListingStats(refreshToken, marketplaceId, page);
      } catch (err) {
        result.error = err.message;
        result.limited = result.limited || !!err.limitReached;
        break;
      }
      for (const item of answer.items) if (byItem.has(item.itemId)) found.set(item.itemId, item);
      if (page >= answer.totalPages) break;
    }
    if (result.limited || result.error) break;
  }

  const now = new Date();
  const ops = [];
  for (const [itemId, item] of found) {
    const l = byItem.get(itemId);
    const set = { watchers: item.watchers, statsSyncedAt: now };
    if (item.views != null) { set.views = item.views; set.viewsSyncedAt = now; result.viewsInBulk = true; }
    ops.push({ updateOne: { filter: { _id: l._id, userId }, update: { $set: set } } });
  }
  if (ops.length) await Listing.bulkWrite(ops, { ordered: false });
  result.synced = found.size;
  result.failed = byItem.size - found.size;

  // eBay sent no view counts: refresh a few, oldest first (listings that are not in the answer are ended on eBay: nothing to read).
  if (!result.viewsInBulk && viewsFallback > 0 && !result.limited && !result.error) {
    const stale = [...found.keys()]
      .map((id) => byItem.get(id))
      .sort((a, b) => (a.viewsSyncedAt ? new Date(a.viewsSyncedAt).getTime() : 0) - (b.viewsSyncedAt ? new Date(b.viewsSyncedAt).getTime() : 0))
      .slice(0, viewsFallback);
    for (const l of stale) {
      if (!(await reserve('stats', 1))) { result.limited = true; break; }
      result.calls += 1;
      try {
        const traffic = await fetchItemTraffic(refreshToken, l.ebayListingId, l.marketplaceId || 'EBAY_US', { counted: true });
        const set = { watchers: traffic.watchers, statsSyncedAt: new Date() };
        if (traffic.views != null) { set.views = traffic.views; set.viewsSyncedAt = set.statsSyncedAt; }
        await Listing.updateOne({ _id: l._id, userId }, { $set: set });
      } catch (err) {
        result.error = result.error || err.message;
        if (err.limitReached) { result.limited = true; break; }
      }
    }
  }
  return result;
}

// What the last background run did, for the admin panel (kept in memory: it is only a status line).
let lastRun = null;
function recordRun(run) { lastRun = { ...run, at: new Date().toISOString() }; }
function getLastRun() { return lastRun; }

module.exports = { syncStatsForAccount, recordRun, getLastRun, MAX_PAGES, VIEWS_FALLBACK_PER_RUN };
