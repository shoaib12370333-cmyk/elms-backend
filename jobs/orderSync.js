const cron = require('node-cron');
const { syncAccountOrders } = require('../services/orderSyncService');
const { getEbayAccountRefreshToken, getEbayAccountById } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const { spendCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const EbayAccount = require('../models/schemas/EbayAccount');
const User = require('../models/schemas/User');

/**
 * Syncs orders for one specific eBay account via the Fulfillment API.
 * Shared by the periodic job below and the immediate webhook-triggered sync.
 */
async function syncOneAccount(userId, accountId, ebayUsername, lastSyncAttemptAt = null) {
  const { savedCount } = await syncAccountOrders(userId, accountId);
  return savedCount;
}

/**
 * Charges a user's daily order-sync credit fee, once per calendar day.
 * Real-time order sync is free; only the polling-only mode is charged
 * (ORDER_SYNC_POLLING_DAILY in config/actionCosts.js). Free users (out of credits) still get synced;
 * we don't want a billing hiccup to cause a seller to silently miss
 * orders, since that has real business consequences for them. The charge
 * simply doesn't succeed and we move on, exactly like the old FREE model
 * behaved for everyone.
 */
async function chargeDailyOrderSyncFeeIfDue(user) {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // The day is claimed in ONE atomic step, so the periodic job and a webhook-triggered sync running at the same moment
  // (or two accounts of one user) can never both charge for the same day.
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, $or: [{ lastOrderSyncCreditChargeAt: null }, { lastOrderSyncCreditChargeAt: { $lt: startOfToday } }] },
    { $set: { lastOrderSyncCreditChargeAt: now } },
    { new: false, projection: { orderSyncMode: 1 } }
  );
  if (!claimed) return; // already handled today

  // Real-time is the default mode (a missing value counts as real-time) and it costs nothing.
  if ((claimed.orderSyncMode || user.orderSyncMode || 'realtime') === 'realtime') return;

  // A user without enough credits is still synced (missing orders would cost them real money); that day is simply free.
  await spendCredit(user._id.toString(), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);
}

/**
 * Periodic order sync - the "safety net" half of the hybrid model. Runs
 * every few minutes and, for each connected eBay account, checks whether
 * that USER's chosen sync interval (orderSyncIntervalMinutes) has elapsed
 * since we last touched their sync. This lets each user have their own
 * cadence (e.g. someone who wants faster polling can set 5 minutes)
 * without needing a separate cron schedule per user.
 *
 * For 'realtime' users, this same interval acts purely as a safety net in
 * case a webhook notification was ever missed - the real-time path
 * (routes/ebayOrderNotification.js -> triggerImmediateSyncForNotification)
 * is what normally keeps them current.
 */
async function runOrderSync() {
  const accounts = await EbayAccount.find();

  if (!accounts.length) {
    console.log('[order-sync] No eBay accounts are connected.');
    return;
  }

  console.log(`[order-sync] Checking ${accounts.length} eBay account(s) for sync...`);
  const now = Date.now();

  for (const account of accounts) {
    const userId = account.userId.toString();
    const accountId = account._id.toString();

    try {
      const user = await User.findById(userId);
      if (!user) continue;

      // Respect this user's own chosen interval - a 'realtime' user's
      // interval is their safety-net cadence; a 'polling' user's interval
      // is their only sync mechanism, so it matters more precisely for them.
      const intervalMs = (user.orderSyncIntervalMinutes || 15) * 60 * 1000;
      const dueForSync = !account.lastSyncAttemptAt || now - account.lastSyncAttemptAt.getTime() >= intervalMs;
      if (!dueForSync) continue;

      await chargeDailyOrderSyncFeeIfDue(user);
      await syncOneAccount(userId, accountId, account.ebayUserId, account.lastSyncAttemptAt);
      await EbayAccount.updateOne({ _id: accountId }, { lastSyncAttemptAt: new Date() });
    } catch (err) {
      console.error(`[order-sync] Could not sync orders for eBay account ${account.ebayUserId}: ${err.message}`);
    }
  }

  console.log('[order-sync] Order sync run complete.');
}

/**
 * Triggered immediately when a verified ORDER_CONFIRMATION webhook
 * arrives (see routes/ebayOrderNotification.js) - the "realtime" half of
 * the hybrid model. We don't try to extract order details from the
 * notification payload itself; we just use it as a trigger to sync the
 * specific eBay account the notification is for, via the same trusted
 * Fulfillment API path the periodic job uses.
 */
async function triggerImmediateSyncForNotification(payload) {
  // The notification's payload structure varies slightly by how eBay
  // formats ORDER_CONFIRMATION, but the seller's eBay user ID/username is
  // always present in some form - we match it back to one of our
  // connected EbayAccount records to know which account to sync.
  const ebayUsername =
    payload?.data?.order?.sellerUsername ||
    payload?.notification?.data?.sellerUsername ||
    payload?.data?.sellerUsername ||
    null;

  if (!ebayUsername) {
    console.warn('[order-sync] Received a notification with no recognizable seller username, ignoring.');
    return;
  }

  const account = await EbayAccount.findOne({ ebayUserId: ebayUsername });
  if (!account) {
    console.warn(`[order-sync] Received a notification for an eBay account we don't have connected: ${ebayUsername}`);
    return;
  }

  console.log(`[order-sync] Realtime notification received for ${ebayUsername}, syncing now...`);
  await syncOneAccount(account.userId.toString(), account._id.toString(), ebayUsername, account.lastSyncAttemptAt);
  await EbayAccount.updateOne({ _id: account._id }, { lastSyncAttemptAt: new Date() });
}

/**
 * Starts the periodic (safety-net) order-sync schedule. Runs every 5
 * minutes - the actual per-user cadence is governed by each user's own
 * orderSyncIntervalMinutes, checked inside runOrderSync, but running the
 * cron itself frequently means realtime users get their safety net
 * checked often without needing a separate schedule per interval choice.
 */
function startOrderSync() {
  cron.schedule('*/5 * * * *', async () => {
    const gotLock = await acquireLock('order-sync', 4 * 60 * 1000).catch(() => false);
    if (!gotLock) {
      console.log('[order-sync] Another instance already holds the lock for this run, skipping.');
      return;
    }

    runOrderSync().catch((err) => {
      console.error('[order-sync] Unexpected error during order sync:', err.message);
    });
  });

  console.log('[order-sync] Order sync scheduled (every 5 minutes, per-user interval respected).');
}

module.exports = { startOrderSync, runOrderSync, triggerImmediateSyncForNotification, chargeDailyOrderSyncFeeIfDue };
