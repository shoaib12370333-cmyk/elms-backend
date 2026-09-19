const cron = require('node-cron');
const EbayAccount = require('../models/schemas/EbayAccount');
const Listing = require('../models/schemas/Listing');
const { syncStatsForAccount } = require('../services/listingStatsService');
const { acquireLock } = require('../services/jobLockService');

/**
 * Refreshes views and watchers for every store that has live listings. Runs every 30 minutes:
 * these numbers move slowly, and one eBay call is needed per listing, so a tighter loop would
 * only spend eBay's daily API allowance without showing anything new.
 */
async function runStatsSync() {
  const accountIds = await Listing.distinct('ebayAccountId', { status: 'published', ebayListingId: { $ne: null }, ebayAccountId: { $ne: null } });
  if (!accountIds.length) return;
  const accounts = await EbayAccount.find({ _id: { $in: accountIds } }).lean();
  let synced = 0;
  for (const account of accounts) {
    try {
      const result = await syncStatsForAccount(account.userId, account._id, { limit: 100 });
      synced += result.synced;
    } catch (err) {
      console.warn('[stats-sync] store ' + account.ebayUserId + ' failed: ' + err.message);
    }
  }
  console.log('[stats-sync] Updated views/watchers for ' + synced + ' listing(s) across ' + accounts.length + ' store(s).');
}

function startStatsSync() {
  cron.schedule('*/30 * * * *', async () => {
    const gotLock = await acquireLock('stats-sync', 25 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runStatsSync().catch((err) => console.error('[stats-sync] Unexpected error:', err.message));
  });
  console.log('[stats-sync] Views/watchers sync scheduled (every 30 minutes).');
}

module.exports = { startStatsSync, runStatsSync };
