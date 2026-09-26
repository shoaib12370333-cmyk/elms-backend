const cron = require('node-cron');
const { withLease } = require('../services/jobLockService');
const { processPublishQueue } = require('../services/publishQueueService');
const { listStalePublishingListings, failStalePublishingListing } = require('../models/listingsModel');
const { refundCredit } = require('../models/usersModel');
const { createSystemNotification } = require('../models/systemNotificationsModel');
const { isQueued } = require('../services/publishRunner');
const { finishDueBatches } = require('../services/publishBatchService');

async function runPublishQueue({ renew } = {}) {
  // A listing that is waiting in this server's line (a long "Publish all") is not stuck: only the ones nothing is working on and nothing
  // is waiting for are failed after 30 minutes. (Before, a listing that waited 30 minutes for its turn was failed as "interrupted".)
  const stale = (await listStalePublishingListings(30)).filter((l) => !isQueued(l.id));
  for (const candidate of stale) {
    // The listing is failed by ONE atomic update that hands back what it was, so only the run that wins it gives the credit back
    // (two overlapping runs, or a run that stopped half way, no longer refund the same credit twice).
    const listing = await failStalePublishingListing(candidate.userId, candidate.id, 30);
    if (!listing) continue;
    if (listing.publish_credit_charged) await refundCredit(listing.userId, require('../config/actionCosts').ACTION_COSTS.EBAY_PUBLISH).catch(() => {});
    await createSystemNotification(listing.userId, { type:'publish_failed', level:'error', title:'Publish interrupted', message:`${listing.title || listing.sku}: the background publish job was interrupted. The credit was refunded and the listing is ready to retry.`, listingId: listing.id, metadata:{code:'PUBLISH_JOB_INTERRUPTED'} }).catch(() => {});
  }
  const count = await processPublishQueue({ afterEach: renew });
  if (count) console.log(`[publish-queue] processed ${count} listing job(s).`);
  // Tell the person about every "Publish all" whose listings have all finished.
  try { await finishDueBatches(); } catch (err) { console.warn('[publish-queue] batch notifications:', err.message); }
}

function startPublishQueue() {
  cron.schedule('* * * * *', async () => {
    // Held until the run is over (a run of many listings takes longer than a minute); the next tick skips while it is going.
    try { await withLease('publish-queue', 15 * 60 * 1000, ({ renew }) => runPublishQueue({ renew })); }
    catch (err) { console.error('[publish-queue] unexpected error:', err.message); }
  });
  console.log('[publish-queue] background publish worker scheduled every minute.');
}

module.exports = { startPublishQueue, runPublishQueue };
