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
  for (const rawOrder of rawOrders) {
    for (const lineItem of normalizeOrderLineItems(rawOrder)) {
      await upsertOrder(userId, lineItem, accountId);
      savedCount += 1;
    }
  }
  await EbayAccount.updateOne({ _id: accountId }, { lastSyncAttemptAt: new Date() });
  // eBay's order data has no pictures: read them from the items, after the sync, without making it wait
  fillMissingOrderImages(userId, accountId, refreshToken).catch((err) => console.warn('[order-images] ' + err.message));
  return { ordersFromEbay: rawOrders.length, savedCount };
}

module.exports = { syncAccountOrders };
