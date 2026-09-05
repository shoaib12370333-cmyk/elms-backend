const cron = require('node-cron');
const { checkAvailabilityByAsin } = require('../services/rapidAmazonService');
const { withdrawListing } = require('../services/ebayListingService');
const { listPublishedListings, markEnded } = require('../models/listingsModel');
const {
  getEbayRefreshToken,
  hasCredits,
  spendCredit,
  listUsersDueForStockCheck,
  markStockCheckRan,
} = require('../models/usersModel');

/**
 * Checks stock for one user's published listings, ending any that have gone
 * out of stock on Amazon. Spends one credit per listing checked (admins are
 * never charged). Stops early if the user runs out of credits partway
 * through their listings.
 */
async function runStockCheckForUser(user) {
  const publishedListings = await listPublishedListings(user.id);

  if (!publishedListings.length) {
    console.log(`[stock-monitor] ${user.email}: no published listings to check.`);
    return;
  }

  console.log(`[stock-monitor] ${user.email}: checking stock for ${publishedListings.length} listing(s)...`);

  for (const listing of publishedListings) {
    if (!listing.asin) {
      console.warn(`[stock-monitor] Listing ${listing.id} (SKU ${listing.sku}) has no ASIN, skipping.`);
      continue;
    }

    if (!(await hasCredits(user.id))) {
      console.warn(`[stock-monitor] ${user.email} ran out of credits mid-check; remaining listings will be checked next time they're due.`);
      break;
    }

    try {
      const availability = await checkAvailabilityByAsin(listing.asin);
      await spendCredit(user.id);

      if (!availability.inStock) {
        console.log(`[stock-monitor] ${listing.sku} is out of stock on Amazon (${availability.availabilityText}). Ending eBay listing...`);

        if (listing.ebay_offer_id) {
          const refreshToken = await getEbayRefreshToken(user.id);
          if (refreshToken) {
            await withdrawListing(refreshToken, listing.ebay_offer_id);
          } else {
            console.warn(`[stock-monitor] User ${user.id} has no eBay connection, could not withdraw ${listing.sku} on eBay (marking ended locally anyway).`);
          }
        }
        await markEnded(user.id, listing.id, `Ended: out of stock on Amazon (${availability.availabilityText || 'unavailable'})`);

        console.log(`[stock-monitor] Listing ${listing.sku} ended.`);
      }
    } catch (err) {
      // A failed check (rate limit, network issue, etc.) should not end the
      // listing - we just log it and try again on the next scheduled run.
      console.error(`[stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    }
  }
}

/**
 * Runs stock checks for every user whose configured interval has elapsed
 * since their last check (set per-user in the Admin Panel, in days). A user
 * with no published listings, or whose interval hasn't elapsed yet, is
 * skipped entirely - this check itself only reads the database and costs
 * nothing; the Amazon API is only called for users who are actually due.
 */
async function runStockCheck() {
  const dueUsers = await listUsersDueForStockCheck();

  if (!dueUsers.length) {
    console.log('[stock-monitor] No users are due for a stock check right now.');
    return;
  }

  console.log(`[stock-monitor] ${dueUsers.length} user(s) due for a stock check.`);

  for (const user of dueUsers) {
    try {
      await runStockCheckForUser(user);
    } catch (err) {
      console.error(`[stock-monitor] Unexpected error checking stock for ${user.email}: ${err.message}`);
    } finally {
      // Mark the check as having run even if it errored, so a persistently
      // failing user doesn't get checked every single day - they'll be
      // retried after their normal interval instead.
      await markStockCheckRan(user.id);
    }
  }

  console.log('[stock-monitor] Stock check run complete.');
}

/**
 * Starts the daily stock-check schedule. Call this once when the server
 * starts. This job itself runs once a day; each user's actual check
 * frequency is controlled by their own stockCheckIntervalDays setting
 * (Admin Panel), checked against their lastStockCheckAt.
 */
function startStockMonitor() {
  // Runs once a day, at midnight server time.
  cron.schedule('0 0 * * *', () => {
    runStockCheck().catch((err) => {
      console.error('[stock-monitor] Unexpected error during stock check:', err.message);
    });
  });

  console.log('[stock-monitor] Daily stock monitor scheduled.');
}

module.exports = { startStockMonitor, runStockCheck };
