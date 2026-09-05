const cron = require('node-cron');
const { publishListing } = require('../services/ebayListingService');
const { listScheduledDue, markPublished, markError } = require('../models/listingsModel');
const { getEbayRefreshToken, getSellerSettings } = require('../models/usersModel');

/**
 * Publishes every scheduled listing (across all users) whose scheduled time
 * has already arrived. Runs on the same hourly cadence as the stock monitor,
 * so a scheduled listing may publish up to an hour after its scheduled time -
 * this is an accepted tradeoff to avoid running a second, more frequent job.
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

    try {
      const refreshToken = await getEbayRefreshToken(listing.userId);
      if (!refreshToken) {
        throw new Error('Your eBay account is not connected.');
      }

      const sellerSettings = await getSellerSettings(listing.userId);

      // The draft's own (possibly edited) title overrides the import's original title.
      const product = { ...listing.import.product, title: listing.title || listing.import.product.title };

      const result = await publishListing({
        refreshToken,
        product,
        sellPrice: listing.sell_price,
        quantity: listing.quantity,
        categoryId: listing.category_id,
        sku: listing.sku,
        sellerSettings,
      });

      await markPublished(listing.userId, listing.id, { offerId: result.offerId, listingId: result.listingId });
      console.log(`[scheduler] Listing ${listing.sku} published successfully.`);
    } catch (err) {
      console.error(`[scheduler] Could not publish scheduled listing ${listing.sku}: ${err.message}`);
      await markError(listing.userId, listing.id, `Scheduled publish failed: ${err.message}`);
    }
  }

  console.log('[scheduler] Scheduled publish run complete.');
}

/**
 * Starts the hourly scheduled-publish job. Call this once when the server starts.
 */
function startScheduledPublisher() {
  // Runs at the top of every hour, alongside the stock monitor.
  cron.schedule('0 * * * *', () => {
    runScheduledPublish().catch((err) => {
      console.error('[scheduler] Unexpected error during scheduled publish run:', err.message);
    });
  });

  console.log('[scheduler] Hourly scheduled-publish job scheduled.');
}

module.exports = { startScheduledPublisher, runScheduledPublish };
