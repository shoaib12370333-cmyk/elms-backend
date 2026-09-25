// The higher "real-time" order-sync fee pays for eBay's live order notification. While that notification is not set up on the server
// (no verification token / public address), the orders come by polling only, so the polling fee is what is charged.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let mode = 'realtime';
const spent = [];
stub('models/schemas/User', { findOneAndUpdate: async () => ({ orderSyncMode: mode }) }); // the day is claimed
stub('models/usersModel', { spendCredit: async (id, n) => { spent.push(n); return true; } });
stub('services/orderSyncService', { syncAccountOrders: async () => ({}) });
stub('models/schemas/EbayAccount', { find: async () => [] });
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => 'rt', getEbayAccountById: async () => null });
stub('services/jobLockService', { acquireLock: async () => true });
const { chargeDailyOrderSyncFeeIfDue, realtimeNotificationsConfigured } = require('../jobs/orderSync');
const { ACTION_COSTS } = require('../config/actionCosts');

const TOKEN = 'EBAY_ORDER_NOTIFICATION_VERIFICATION_TOKEN';
const URL_VAR = 'EBAY_ORDER_NOTIFICATION_ENDPOINT_URL';
const setEnv = (token, url) => { for (const [k, v] of [[TOKEN, token], [URL_VAR, url]]) { if (v) process.env[k] = v; else delete process.env[k]; } };
const charge = async (userMode) => { spent.length = 0; mode = userMode; await chargeDailyOrderSyncFeeIfDue({ _id: 'u1', orderSyncMode: userMode }); return spent[0]; };

(async () => {
  assert.ok(ACTION_COSTS.ORDER_SYNC_REALTIME_DAILY > ACTION_COSTS.ORDER_SYNC_POLLING_DAILY, 'real-time normally costs more');

  // not set up (the situation on the live server): a real-time user pays the polling fee
  setEnv(null, null);
  assert.strictEqual(realtimeNotificationsConfigured(), false);
  assert.strictEqual(await charge('realtime'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY, 'no live notification, so no live fee');
  assert.strictEqual(await charge('polling'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);

  // half set up is not set up
  setEnv('token', null);
  assert.strictEqual(realtimeNotificationsConfigured(), false);
  assert.strictEqual(await charge('realtime'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);
  setEnv(null, 'https://api.example.com/api/ebay/order-notification');
  assert.strictEqual(realtimeNotificationsConfigured(), false);
  assert.strictEqual(await charge('realtime'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);

  // set up: the real-time fee applies to real-time users, polling users still pay the polling fee
  setEnv('token', 'https://api.example.com/api/ebay/order-notification');
  assert.strictEqual(realtimeNotificationsConfigured(), true);
  assert.strictEqual(await charge('realtime'), ACTION_COSTS.ORDER_SYNC_REALTIME_DAILY);
  assert.strictEqual(await charge('polling'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);

  setEnv(null, null);
  console.log('order sync fee tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
