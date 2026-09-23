const cron = require('node-cron');
const { processOneQueuedListing } = require('../services/publishQueueService');
const { listScheduledDue, claimScheduledForPublishing, markError } = require('../models/listingsModel');
const { acquireLock } = require('../services/jobLockService');

/**
 * Publishes every scheduled listing (across all users) whose scheduled time
 * has already arrived. Runs every 5 minutes, so a scheduled listing
 * publishes within about 5 minutes of its requested time.
 */
async function runScheduledPublish() {
  const dueListings = await listScheduledDue();

  if (!dueListings.length) {
    console.log('[scheduler] No scheduled listings are due.');
    return;
  }

  console.log(`[scheduler] Publishing ${dueListings.length} scheduled listing(s)...`);

  for (const listing of dueListings) {
    try {
      // Move it scheduled -> publishing atomically (skips it if another run already took it), then let the
      // normal publish pipeline handle it: the same validation, the draft's edited title/description/
      // specifications/aspects, currency conversion, item-specifics + category + package-weight checks,
      // credit charge/refund and failure notification as a manual publish. (This job used to carry its
      // own, weaker copy that read camelCase fields off snake_case listings, so every scheduled listing
      // failed with "no eBay account was set".)
      const claimed = await claimScheduledForPublishing(listing.userId, listing.id);
      if (!claimed) continue;
      await processOneQueuedListing(claimed);
    } catch (err) {
      console.error(`[scheduler] Could not publish scheduled listing ${listing.sku}: ${err.message}`);
      await markError(listing.userId, listing.id, `Scheduled publish failed: ${err.message}`).catch(() => {});
    }
  }

  console.log('[scheduler] Scheduled publish run complete.');
}

/**
 * Starts the scheduled-publish job. Call this once when the server starts.
 * Runs every 5 minutes (rather than hourly) so a scheduled listing
 * publishes within about 5 minutes of its requested time, instead of
 * potentially waiting up to an hour for the next run.
 */
function startScheduledPublisher() {
  cron.schedule('*/5 * * * *', async () => {
    const gotLock = await acquireLock('scheduled-publisher', 4 * 60 * 1000).catch(() => false);
    if (!gotLock) {
      console.log('[scheduler] Another instance already holds the lock for this run, skipping.');
      return;
    }

    runScheduledPublish().catch((err) => {
      console.error('[scheduler] Unexpected error during scheduled publish run:', err.message);
    });
  });

  console.log('[scheduler] Scheduled-publish job scheduled every 5 minutes.');
}

module.exports = { startScheduledPublisher, runScheduledPublish };
