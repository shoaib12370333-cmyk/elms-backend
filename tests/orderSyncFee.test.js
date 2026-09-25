// Real-time order sync is free. Only the polling-only mode is charged (once a day), whatever the eBay notification set-up looks like.
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
const orderSync = require('../jobs/orderSync');
const { chargeDailyOrderSyncFeeIfDue } = orderSync;
const { ACTION_COSTS, ACTION_COST_METADATA } = require('../config/actionCosts');

const TOKEN = 'EBAY_ORDER_NOTIFICATION_VERIFICATION_TOKEN';
const URL_VAR = 'EBAY_ORDER_NOTIFICATION_ENDPOINT_URL';
const charge = async (userMode) => { spent.length = 0; mode = userMode; await chargeDailyOrderSyncFeeIfDue({ _id: 'u1', orderSyncMode: userMode }); return spent[0]; };

(async () => {
  // no price exists for real-time, and the admin panel has no row for it
  assert.strictEqual(ACTION_COSTS.ORDER_SYNC_REALTIME_DAILY, undefined, 'there is no real-time price any more');
  assert.ok(!ACTION_COST_METADATA.some((m) => m.key === 'ORDER_SYNC_REALTIME_DAILY'), 'and no admin row for one');
  assert.strictEqual(typeof orderSync.realtimeNotificationsConfigured, 'undefined', 'the fee no longer depends on the eBay notification set-up');

  // real-time users pay nothing; polling users pay the polling fee
  assert.strictEqual(await charge('realtime'), undefined, 'real-time is free');
  assert.strictEqual(await charge('polling'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);
  assert.ok(ACTION_COSTS.ORDER_SYNC_POLLING_DAILY > 0);

  // a user record without the field is on the default mode, which is real-time
  assert.strictEqual(await charge(undefined), undefined, 'a missing mode counts as real-time: free');

  // setting up the eBay notification changes nothing about the price
  process.env[TOKEN] = 'token'; process.env[URL_VAR] = 'https://api.example.com/api/ebay/order-notification';
  assert.strictEqual(await charge('realtime'), undefined, 'real-time stays free with the notification set up');
  assert.strictEqual(await charge('polling'), ACTION_COSTS.ORDER_SYNC_POLLING_DAILY);
  delete process.env[TOKEN]; delete process.env[URL_VAR];

  // an admin override that was saved earlier for the removed key is ignored at start-up, and cannot be saved again
  const settingsPath = require.resolve('../models/schemas/Settings');
  require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { findOne: () => ({ lean: async () => ({ actionCosts: { ORDER_SYNC_REALTIME_DAILY: 10, ORDER_SYNC_POLLING_DAILY: 7 } }) }) } };
  const { applyActionCostOverridesOnStartup, updateActionCosts } = require('../models/settingsModel');
  const oldPolling = ACTION_COSTS.ORDER_SYNC_POLLING_DAILY;
  await applyActionCostOverridesOnStartup();
  assert.strictEqual(ACTION_COSTS.ORDER_SYNC_REALTIME_DAILY, undefined, 'the old saved 10 did not come back');
  assert.strictEqual(ACTION_COSTS.ORDER_SYNC_POLLING_DAILY, 7, 'other saved prices still apply');
  ACTION_COSTS.ORDER_SYNC_POLLING_DAILY = oldPolling;
  await assert.rejects(() => updateActionCosts({ ORDER_SYNC_REALTIME_DAILY: 10 }), /No valid action cost/);

  console.log('order sync fee tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
