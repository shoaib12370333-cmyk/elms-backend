const { fetchOrders, normalizeOrderLineItems } = require('./ebayOrdersService');
const { upsertOrder } = require('../models/ordersModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const EbayAccount = require('../models/schemas/EbayAccount');
const { fillMissingOrderImages } = require('./orderImageService');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pulls every order eBay has changed since the last sync for ONE seller
 * account and stores each line item. The first sync (or full: true) reads the
 * last 90 days; later syncs re-read from 48 hours before the previous one, by
 * last-modified time, so payment / shipping / cancellation changes on eBay are
 * picked up as well as new orders.
 *
 * @returns {Promise<{ ordersFromEbay: number, savedCount: number }>}
 */
async function syncAccountOrders(userId, accountId, { full = false } = {}) {
  const refreshToken = await getEbayAccountRefreshToken(userId, accountId);
  if (!refreshToken) return { ordersFromEbay: 0, savedCount: 0 };

  const account = await EbayAccount.findById(accountId);
  const last = account?.lastSyncAttemptAt;
  const sinceDate = full || !last ? new Date(Date.now() - 90 * DAY_MS) : new Date(last.getTime() - 2 * DAY_MS);

  const rawOrders = await fetchOrders(refreshToken, sinceDate);
  let savedCount = 0;
  let failedCount = 0;
  for (const rawOrder of rawOrders) {
    // One order's own data being unexpected (a bad line item shape, a duplicate-key edge case that isn't actually a
    // duplicate, etc) must never stop every order that comes after it in eBay's response - it used to: an uncaught
    // throw here escaped both loops, skipping the rest of rawOrders entirely, and skipping every one of them again
    // on every future run too (the loop always starts from the same position in eBay's response). Isolating each
    // order lets its siblings save normally; the failed order itself is naturally retried on the NEXT sync anyway,
    // since lastSyncAttemptAt still advances below and the 48-hour overlap window re-fetches anything this recent.
    try {
      for (const lineItem of normalizeOrderLineItems(rawOrder)) {
        await upsertOrder(userId, lineItem, accountId);
        savedCount += 1;
      }
    } catch (err) {
      failedCount += 1;
      console.error(`[order-sync] Could not save order ${rawOrder?.orderId || '(unknown id)'} for account ${accountId}: ${err.message}`);
    }
  }
  await EbayAccount.updateOne({ _id: accountId }, { lastSyncAttemptAt: new Date() });
  // eBay's order data has no pictures: read them from the items, after the sync, without making it wait
  fillMissingOrderImages(userId, accountId, refreshToken).catch((err) => console.warn('[order-images] ' + err.message));
  return { ordersFromEbay: rawOrders.length, savedCount, failedCount };
}

module.exports = { syncAccountOrders };
