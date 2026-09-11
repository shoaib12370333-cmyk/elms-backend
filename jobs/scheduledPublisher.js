const cron = require('node-cron');
const { publishListing } = require('../services/ebayListingService');
const { listScheduledDue, markPublished, markError } = require('../models/listingsModel');
const { getEbayAccountById, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');

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
    if (!listing.import || !listing.import.product) {
      console.warn(`[scheduler] Listing ${listing.id} (SKU ${listing.sku}) has no linked product data, marking as error.`);
      await markError(listing.userId, listing.id, 'Scheduled publish failed: no linked Amazon product data was found.');
      continue;
    }

    // IMPORTANT: use the SPECIFIC eBay account this was scheduled with
    // (set at schedule time - see routes/listings.js /:id/schedule), not
    // just "the user's active account." A user may have multiple eBay
    // accounts, and this schedule could be for any one of them.
    if (!listing.ebayAccountId) {
      console.warn(`[scheduler] Listing ${listing.id} (SKU ${listing.sku}) has no eBay account set, marking as error.`);
      await markError(listing.userId, listing.id, 'Scheduled publish failed: no eBay account was set for this schedule.');
      continue;
    }

    try {
      const sellerSettings = await getEbayAccountById(listing.userId, listing.ebayAccountId);
      if (!sellerSettings) {
        throw new Error('The eBay account for this schedule could not be found. Please reconnect it in Settings.');
      }

      const refreshToken = await getEbayAccountRefreshToken(listing.userId, listing.ebayAccountId);
      if (!refreshToken) {
        throw new Error('The eBay account for this schedule is not connected.');
      }

      if (!(await hasCredits(listing.userId, ACTION_COSTS.SCHEDULED_PUBLISH))) {
        throw new Error('Out of credits. Please open a support ticket to request more.');
      }

      // The draft's own (possibly edited) title overrides the import's original title.
      const product = { ...listing.import.product, title: listing.title || listing.import.product.title };

      const charged = await spendCredit(listing.userId, ACTION_COSTS.SCHEDULED_PUBLISH);

      try {
        const result = await publishListing({
          refreshToken,
          product,
          sellPrice: listing.sell_price,
          quantity: listing.quantity,
          categoryId: listing.category_id,
          sku: listing.sku,
          sellerSettings,
        });

        await markPublished(listing.userId, listing.id, {
          offerId: result.offerId,
          listingId: result.listingId,
          ebayAccountId: listing.ebayAccountId,
        });
        console.log(`[scheduler] Listing ${listing.sku} published successfully.`);
      } catch (publishErr) {
        // The listing didn't actually go live - refund so a failed
        // scheduled attempt doesn't permanently cost the user a credit.
        if (charged) await refundCredit(listing.userId, ACTION_COSTS.SCHEDULED_PUBLISH);
        throw publishErr;
      }
    } catch (err) {
      console.error(`[scheduler] Could not publish scheduled listing ${listing.sku}: ${err.message}`);
      await markError(listing.userId, listing.id, `Scheduled publish failed: ${err.message}`);
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

  console.log('[scheduler] Hourly scheduled-publish job scheduled.');
}

module.exports = { startScheduledPublisher, runScheduledPublish };
