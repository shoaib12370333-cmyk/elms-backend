const EbayAccount = require('../models/schemas/EbayAccount');
const { syncAccountOrders } = require('./orderSyncService');
const { syncConversationsForUser } = require('../jobs/conversationSync');
const { createSystemNotification } = require('../models/systemNotificationsModel');

/**
 * Runs ONCE per connected store, right after it is connected: imports the last 90 days of eBay orders and
 * the message inbox (business policies are fetched by the connect callback itself). After this the normal
 * background jobs keep things current. It is never repeated, even if the store is reconnected.
 */
async function runInitialSync(userId, account) {
  const fresh = await EbayAccount.findOneAndUpdate(
    { _id: account.id, userId, initialSyncedAt: null },
    { $set: { initialSyncedAt: new Date() } },
    { new: false }
  );
  if (!fresh) return { skipped: true };

  const label = account.displayName || account.ebayUserId;
  const summary = { orders: 0, conversations: 0, errors: [] };
  try {
    const o = await syncAccountOrders(userId, account.id, { full: true });
    summary.orders = o.ordersFromEbay;
  } catch (err) {
    summary.errors.push('orders: ' + err.message);
  }
  try {
    const c = await syncConversationsForUser(userId, account.id);
    summary.conversations = c.conversations || 0;
  } catch (err) {
    summary.errors.push('messages: ' + err.message);
  }

  // If the import failed, let the next connect try again.
  if (summary.errors.length === 2) await EbayAccount.updateOne({ _id: account.id }, { $set: { initialSyncedAt: null } });

  await createSystemNotification(userId, {
    type: 'store_connected',
    level: summary.errors.length ? 'warning' : 'success',
    ebayAccountId: account.id,
    title: 'Store connected: ' + label,
    message: 'Imported ' + summary.orders + ' order(s) and ' + summary.conversations + ' conversation(s) from eBay.' + (summary.errors.length ? ' Some parts failed (' + summary.errors.join('; ') + '). Use Sync on the Orders / Messages page to retry.' : ''),
  }).catch(() => {});
  return summary;
}

module.exports = { runInitialSync };
