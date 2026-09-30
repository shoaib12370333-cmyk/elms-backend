// jobs/orderSync.js's periodic (safety-net) sync: each account is only synced once its OWN user's
// orderSyncIntervalMinutes has elapsed since lastSyncAttemptAt. A dead refresh token or a missing scope can never be
// fixed by retrying - only the seller reconnecting the account fixes it - so lastSyncAttemptAt must still advance on
// that specific class of failure, or the account gets retried on every single 5-minute cron tick forever regardless
// of the user's chosen interval (confirmed 2026-09-30 against a real broken account hammering eBay's token endpoint).
// A genuinely transient failure (anything else) must NOT advance it, so it is retried on the very next tick.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let accounts = [];
let users = {};
const updates = []; // { accountId, fields }
let syncImpl = async () => ({ savedCount: 0 });

stub('models/schemas/EbayAccount', {
  find: async (q) => accounts.filter((a) => q.disconnectedAt === undefined || a.disconnectedAt === q.disconnectedAt),
  updateOne: async (q, fields) => { updates.push({ accountId: String(q._id), fields }); const a = accounts.find((x) => x._id === q._id); if (a) Object.assign(a, fields); },
  findOne: async () => null,
});
stub('models/schemas/User', {
  findById: async (id) => users[id] || null,
  findOneAndUpdate: async (q) => (users[q._id] ? { orderSyncMode: users[q._id].orderSyncMode } : null), // charge-fee claim: not under test here, always "already handled"
});
stub('services/orderSyncService', { syncAccountOrders: async (userId, accountId) => syncImpl(userId, accountId) });
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => 'rt', getEbayAccountById: async () => null });
stub('services/jobLockService', { acquireLock: async () => true });
stub('models/usersModel', { spendCredit: async () => true });
stub('config/actionCosts', { ACTION_COSTS: { ORDER_SYNC_POLLING_DAILY: 5 } });

const { runOrderSync } = require('../jobs/orderSync');

const account = (over = {}) => ({ _id: 'acc1', userId: 'u1', ebayUserId: 'seller1', disconnectedAt: null, lastSyncAttemptAt: null, ...over });
const reset = () => { accounts = [account()]; users = { u1: { _id: 'u1', orderSyncIntervalMinutes: 15, orderSyncMode: 'realtime' } }; updates.length = 0; };

(async () => {
  // ---------- a successful sync always advances lastSyncAttemptAt ----------
  reset();
  let syncCalls = 0;
  syncImpl = async () => { syncCalls += 1; return { savedCount: 1 }; };
  await runOrderSync();
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(updates.length, 1);
  assert.ok(updates[0].fields.lastSyncAttemptAt instanceof Date);

  // ---------- not due yet (15-minute interval, synced 2 minutes ago): skipped entirely ----------
  reset();
  accounts[0].lastSyncAttemptAt = new Date(Date.now() - 2 * 60 * 1000);
  syncCalls = 0; syncImpl = async () => { syncCalls += 1; return { savedCount: 0 }; };
  await runOrderSync();
  assert.strictEqual(syncCalls, 0, 'not due for 13 more minutes');
  assert.strictEqual(updates.length, 0);

  // ---------- a dead refresh token (eBay's real production wording) still advances lastSyncAttemptAt - the fix ----------
  reset();
  syncImpl = async () => { const e = new Error('the provided authorization refresh token is invalid or was issued to another client'); e.statusCode = 400; throw e; };
  await runOrderSync();
  assert.strictEqual(updates.length, 1, 'an unrecoverable auth error still advances the timestamp, so the next tick respects the 15-minute interval instead of retrying in 5');
  assert.ok(updates[0].fields.lastSyncAttemptAt instanceof Date);

  // ---------- the missing-Finances-scope wording is the same case ----------
  reset();
  syncImpl = async () => { const e = new Error('The requested scope is invalid, unknown, malformed, or exceeds the scope granted to the client'); e.statusCode = 400; throw e; };
  await runOrderSync();
  assert.strictEqual(updates.length, 1);

  // ---------- a genuinely transient failure (anything else) does NOT advance it - retried on the very next tick ----------
  reset();
  syncImpl = async () => { throw new Error('eBay timed out.'); };
  await runOrderSync();
  assert.strictEqual(updates.length, 0, 'a transient error must not be treated like a dead account');

  console.log('order sync tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
