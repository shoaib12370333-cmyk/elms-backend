const cron = require('node-cron');
const { fetchOrders, normalizeOrderLineItems } = require('../services/ebayOrdersService');
const { upsertOrder } = require('../models/ordersModel');
const { getEbayRefreshToken } = require('../models/usersModel');
const User = require('../models/schemas/User');

/**
 * Syncs orders from eBay for every user with a connected eBay account.
 * Safe to run repeatedly - existing orders are matched and updated rather
 * than duplicated (see models/ordersModel.upsertOrder).
 */
async function runOrderSync() {
  const connectedUsers = await User.find({ ebayConnected: true });

  if (!connectedUsers.length) {
    console.log('[order-sync] No users have a connected eBay account.');
    return;
  }

  console.log(`[order-sync] Syncing orders for ${connectedUsers.length} user(s)...`);

  for (const user of connectedUsers) {
    try {
      const refreshToken = await getEbayRefreshToken(user._id.toString());
      if (!refreshToken) continue;

      const rawOrders = await fetchOrders(refreshToken);

      for (const rawOrder of rawOrders) {
        const lineItems = normalizeOrderLineItems(rawOrder);
        for (const lineItem of lineItems) {
          await upsertOrder(user._id.toString(), lineItem);
        }
      }
    } catch (err) {
      console.error(`[order-sync] Could not sync orders for ${user.email}: ${err.message}`);
    }
  }

  console.log('[order-sync] Order sync run complete.');
}

/**
 * Starts the periodic order-sync schedule. Runs every 30 minutes, so new
 * buyer orders show up in ELMS without the user needing to manually sync.
 */
function startOrderSync() {
  cron.schedule('*/30 * * * *', () => {
    runOrderSync().catch((err) => {
      console.error('[order-sync] Unexpected error during order sync:', err.message);
    });
  });

  console.log('[order-sync] Order sync scheduled (every 30 minutes).');
}

module.exports = { startOrderSync, runOrderSync };
