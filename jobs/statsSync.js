const cron = require('node-cron');
const EbayAccount = require('../models/schemas/EbayAccount');
const Listing = require('../models/schemas/Listing');
const Session = require('../models/schemas/Session');
const { syncStatsForAccount, recordRun } = require('../services/listingStatsService');
const { snapshot } = require('../services/ebayCallBudget');
const { acquireLock } = require('../services/jobLockService');

// A store whose owner has not opened ELMS for this long is not refreshed: nobody is looking at the numbers, and the page
// refreshes them by itself the moment the owner comes back.
const ACTIVE_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

let runCounter = 0;
const rotate = (rows, by) => (rows.length ? rows.slice(by % rows.length).concat(rows.slice(0, by % rows.length)) : rows);

/** User ids that used ELMS recently; null when that cannot be told (then every store is refreshed). */
async function activeUserIds() {
  try {
    const ids = await Session.distinct('userId', { revokedAt: null, lastSeenAt: { $gte: new Date(Date.now() - ACTIVE_WITHIN_MS) } });
    return new Set(ids.map(String));
  } catch (err) {
    console.warn('[stats-sync] could not tell which sellers are active, refreshing all:', err.message);
    return null;
  }
}

/**
 * Refreshes watchers (and views) for every store that has live listings, every 30 minutes.
 * Each store is read with a handful of eBay calls (200 listings per call) that are counted against eBay's daily allowance for
 * the whole application (services/ebayCallBudget.js). The run starts with a different store each time, so when the day's share
 * runs out it is never always the same stores that go without.
 */
async function runStatsSync() {
  const before = await snapshot();
  if (before.exhausted || before.stats >= before.statsLimit) {
    console.log('[stats-sync] Skipped: today\'s eBay call budget for statistics is used up (' + before.stats + '/' + before.statsLimit + ').');
    recordRun({ skipped: 'budget', stores: 0, synced: 0, calls: 0, viewsInBulk: false });
    return;
  }

  const accountIds = await Listing.distinct('ebayAccountId', { status: 'published', ebayListingId: { $ne: null }, ebayAccountId: { $ne: null } });
  if (!accountIds.length) return;
  let accounts = await EbayAccount.find({ _id: { $in: accountIds } }).lean();
  const active = await activeUserIds();
  const total = accounts.length;
  if (active) accounts = accounts.filter((a) => active.has(String(a.userId)));
  accounts = rotate(accounts, runCounter++);

  const run = { stores: accounts.length, idleStores: total - accounts.length, synced: 0, failed: 0, calls: 0, viewsInBulk: false, limited: false };
  for (const account of accounts) {
    try {
      const result = await syncStatsForAccount(account.userId, account._id);
      run.synced += result.synced;
      run.failed += result.failed;
      run.calls += result.calls;
      run.viewsInBulk = run.viewsInBulk || result.viewsInBulk;
      if (result.limited) { run.limited = true; break; } // the day's share is gone: the other stores wait for tomorrow
    } catch (err) {
      console.warn('[stats-sync] store ' + account.ebayUserId + ' failed: ' + err.message);
    }
  }
  recordRun(run);
  console.log('[stats-sync] Updated watchers for ' + run.synced + ' listing(s) across ' + run.stores + ' store(s) with ' + run.calls + ' eBay call(s)'
    + (run.idleStores ? ' (' + run.idleStores + ' idle store(s) skipped)' : '') + (run.limited ? ' - stopped early: daily budget used up' : '') + '.');
}

function startStatsSync() {
  cron.schedule('*/30 * * * *', async () => {
    const gotLock = await acquireLock('stats-sync', 25 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runStatsSync().catch((err) => console.error('[stats-sync] Unexpected error:', err.message));
  });
  console.log('[stats-sync] Views/watchers sync scheduled (every 30 minutes, 200 listings per eBay call, daily call budget).');
}

module.exports = { startStatsSync, runStatsSync, rotate };
