const cron = require('node-cron');
const { acquireLock } = require('../services/jobLockService');
const { processPublishQueue } = require('../services/publishQueueService');
const { listStalePublishingListings, recoverStalePublishingListings } = require('../models/listingsModel');
const { refundCredit } = require('../models/usersModel');
const { createSystemNotification } = require('../models/systemNotificationsModel');

async function runPublishQueue() {
  const stale = await listStalePublishingListings(30);
  for (const listing of stale) {
    if (listing.publish_credit_charged) await refundCredit(listing.userId, require('../config/actionCosts').ACTION_COSTS.EBAY_PUBLISH).catch(() => {});
    await createSystemNotification(listing.userId, { type:'publish_failed', level:'error', title:'Publish interrupted', message:`${listing.title || listing.sku}: the background publish job was interrupted. The credit was refunded and the listing is ready to retry.`, listingId: listing.id, metadata:{code:'PUBLISH_JOB_INTERRUPTED'} }).catch(() => {});
  }
  if (stale.length) await recoverStalePublishingListings(30);
  const count = await processPublishQueue();
  if (count) console.log(`[publish-queue] processed ${count} listing job(s).`);
}

function startPublishQueue() {
  cron.schedule('* * * * *', async () => {
    const gotLock = await acquireLock('publish-queue', 55 * 1000).catch(() => false);
    if (!gotLock) return;
    try { await runPublishQueue(); }
    catch (err) { console.error('[publish-queue] unexpected error:', err.message); }
  });
  console.log('[publish-queue] background publish worker scheduled every minute.');
}

module.exports = { startPublishQueue, runPublishQueue };
