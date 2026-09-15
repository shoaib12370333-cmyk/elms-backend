const cron = require('node-cron');
const { checkAvailabilityByAsin } = require('../services/canopyAmazonService');
const { withdrawListing, updateOfferPrice } = require('../services/ebayListingService');
const { listPublishedListings, markEnded, updateListing } = require('../models/listingsModel');
const { updateImportPrice } = require('../models/importsModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const { ACTION_COSTS } = require('../config/actionCosts');
const {
  hasCredits,
  spendCredit,
  listUsersDueForStockCheck,
  markStockCheckRan,
} = require('../models/usersModel');

/**
 * Checks stock for one user's published listings, ending any that have gone
 * out of stock on Amazon. Spends credits per ACTION_COSTS.STOCK_MONITORING
 * per listing checked (admins are never charged). Stops early if the user
 * runs out of credits partway through their listings.
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

    if (!(await hasCredits(user.id, ACTION_COSTS.STOCK_MONITORING))) {
      console.warn(`[stock-monitor] ${user.email} ran out of credits mid-check; remaining listings will be checked next time they're due.`);
      break;
    }

    try {
      const availability = await checkAvailabilityByAsin(listing.asin);
      await spendCredit(user.id, ACTION_COSTS.STOCK_MONITORING);

      if (!availability.inStock) {
        console.log(`[stock-monitor] ${listing.sku} is out of stock on Amazon (${availability.availabilityText}). Ending eBay listing...`);

        if (listing.ebay_offer_id) {
          // IMPORTANT: use the SPECIFIC eBay account this listing was
          // published through, not just "the user's active account" -
          // a user may have multiple eBay accounts, and this listing
          // could belong to any one of them.
          const refreshToken = listing.ebay_account_id
            ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id)
            : null;

          if (refreshToken) {
            await withdrawListing(refreshToken, listing.ebay_offer_id);
          } else {
            console.warn(`[stock-monitor] Could not find the eBay account for listing ${listing.sku} (user ${user.id}), could not withdraw on eBay (marking ended locally anyway).`);
          }
        }
        await markEnded(user.id, listing.id, `Ended: out of stock on Amazon (${availability.availabilityText || 'unavailable'})`);

        console.log(`[stock-monitor] Listing ${listing.sku} ended.`);
        continue; // it's ended - no point price-checking it too
      }

      // Still in stock - check whether Amazon's price moved, and keep the
      // eBay price in sync (see syncPriceIfChanged below). This reuses the
      // availability response above, so it's not a second Canopy call and
      // not a second credit charge (ACTION_COSTS.PRICE_MONITORING is 0).
      await syncPriceIfChanged(user, listing, availability);
    } catch (err) {
      // A failed check (rate limit, network issue, etc.) should not end the
      // listing - we just log it and try again on the next scheduled run.
      console.error(`[stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    }
  }
}

/**
 * Keeps a published listing's eBay price in sync with Amazon, using the
 * price+stock data already fetched by runStockCheckForUser (no extra
 * Canopy call, no extra credit charge).
 *
 * Design: rather than a fixed cash markup, this preserves the seller's
 * original MARKUP RATIO (sellPrice / amazonPrice at the time it was last
 * priced) - so a listing priced at +25% over Amazon keeps selling at +25%
 * as Amazon's price moves, instead of drifting to a random margin. The
 * Amazon price baseline (Import.amazonPrice) is refreshed on every check
 * regardless of whether the eBay price actually moved, so the next check
 * always compares against the true previous price.
 */
async function syncPriceIfChanged(user, listing, availability) {
  const newAmazonPrice = availability.price;
  if (newAmazonPrice == null) return; // Canopy didn't return a usable price this time - skip silently

  const oldAmazonPrice = listing.amazon_price;
  const priceIsNewOrUnknown = oldAmazonPrice == null || !Number.isFinite(oldAmazonPrice) || oldAmazonPrice <= 0;
  const priceUnchanged = !priceIsNewOrUnknown && Math.abs(newAmazonPrice - oldAmazonPrice) < 0.01;

  try {
    if (priceIsNewOrUnknown || priceUnchanged || listing.sell_price == null || !listing.ebay_offer_id) {
      // Nothing to compare against yet, no real change, or nothing to
      // update on eBay (no sell price / not actually published) - just
      // record the current price as next check's baseline.
      return;
    }

    const markupRatio = listing.sell_price / oldAmazonPrice;
    const newSellPrice = Number((newAmazonPrice * markupRatio).toFixed(2));

    const refreshToken = listing.ebay_account_id
      ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id)
      : null;

    if (!refreshToken) {
      console.warn(`[price-monitor] Could not find the eBay account for listing ${listing.sku} (user ${user.id}), skipped eBay price update.`);
      return;
    }

    await updateOfferPrice(refreshToken, listing.ebay_offer_id, newSellPrice);
    await updateListing(user.id, listing.id, { sellPrice: newSellPrice });
    console.log(`[price-monitor] ${listing.sku}: Amazon price ${oldAmazonPrice} -> ${newAmazonPrice}, eBay price updated to ${newSellPrice}.`);
  } catch (err) {
    // A failed eBay price update should not block recording the new Amazon
    // baseline below - we just try the eBay update again next time.
    console.error(`[price-monitor] Could not update eBay price for ${listing.sku}: ${err.message}`);
  } finally {
    if (listing.import_id) await updateImportPrice(user.id, listing.import_id, newAmazonPrice);
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
  cron.schedule('0 0 * * *', async () => {
    // If this app is ever scaled to multiple instances, only one should
    // actually run this job per day - the lock (held for slightly less
    // than 24h) ensures the others skip it for this run.
    const gotLock = await acquireLock('stock-monitor', 23 * 60 * 60 * 1000).catch(() => false);
    if (!gotLock) {
      console.log('[stock-monitor] Another instance already holds the lock for this run, skipping.');
      return;
    }

    runStockCheck().catch((err) => {
      console.error('[stock-monitor] Unexpected error during stock check:', err.message);
    });
  });

  console.log('[stock-monitor] Daily stock monitor scheduled.');
}

module.exports = { startStockMonitor, runStockCheck };
