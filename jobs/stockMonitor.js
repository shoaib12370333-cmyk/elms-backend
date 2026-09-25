const cron = require('node-cron');
const { checkAvailabilityByAsin, detectCountryFromUrl } = require('../services/canopyAmazonService');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { sourceCurrency } = require('../config/amazonDomains');
const { convertAmount } = require('../services/currencyService');
const { withdrawListing, updateOfferPrice, updateOfferQuantity } = require('../services/ebayListingService');
const { getSavedMargin, repriceFor } = require('../services/repricingService');
const { listPublishedListings, markEnded, updateListing } = require('../models/listingsModel');
const { updateImportPrice } = require('../models/importsModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const { ACTION_COSTS } = require('../config/actionCosts');
const {
  spendCredit,
  refundCredit,
  listUsersDueForStockCheck,
  markStockCheckRan,
} = require('../models/usersModel');

/**
 * The Amazon site a listing's product is read from. Its own link says so; when that is missing, the site that matches the eBay
 * store (a UK store sells amazon.co.uk products). An ASIN asked of the wrong site is usually "not found" there, which would
 * look like "out of stock" and end a perfectly good listing - so this is never left to a US default when anything is known.
 */
function supplierCountryOf(listing) {
  if (listing.amazon_url && /^https?:\/\//i.test(listing.amazon_url)) return detectCountryFromUrl(listing.amazon_url);
  return getMarketplaceConfig(listing.marketplace_id)?.country || 'US';
}

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
    // Both monitors switched off for this product in the listing editor: skip it (and save the credit).
    if (listing.stock_monitoring === false && listing.price_monitoring === false) continue;
    if (!listing.asin) {
      console.warn(`[stock-monitor] Listing ${listing.id} (SKU ${listing.sku}) has no ASIN, skipping.`);
      continue;
    }

    // Pay first (an atomic charge, so a check is never run for free); the credit comes back if the check itself fails.
    if (!(await spendCredit(user.id, ACTION_COSTS.STOCK_MONITORING))) {
      console.warn(`[stock-monitor] ${user.email} ran out of credits mid-check; remaining listings will be checked next time they're due.`);
      break;
    }

    try {
      let availability;
      try {
        availability = await checkAvailabilityByAsin(listing.asin, supplierCountryOf(listing));
      } catch (checkErr) {
        await refundCredit(user.id, ACTION_COSTS.STOCK_MONITORING).catch((e) => console.error(`[credits] REFUND FAILED for user ${user.id}: ${e.message}`));
        throw checkErr;
      }

      if (!availability.inStock && listing.stock_monitoring !== false) {
        console.log(`[stock-monitor] ${listing.sku} is out of stock on Amazon (${availability.availabilityText}). Ending eBay listing...`);

        if (!listing.ebay_offer_id) {
          await markEnded(user.id, listing.id, `Ended: out of stock on Amazon (${availability.availabilityText || 'unavailable'})`);
          console.log(`[stock-monitor] Listing ${listing.sku} ended locally (no eBay offer ID exists).`);
          continue;
        }

        // IMPORTANT: use the SPECIFIC eBay account this listing was
        // published through, not just "the user's active account".
        const refreshToken = listing.ebay_account_id
          ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id)
          : null;

        if (!refreshToken) {
          // Do NOT mark the listing ended locally when we cannot withdraw the
          // real eBay offer. Otherwise ELMS could show "ended" while eBay is
          // still selling the item. Leave it published so the next run can
          // retry the withdrawal.
          console.warn(`[stock-monitor] Could not find the eBay account for listing ${listing.sku}; leaving it published so withdrawal can be retried.`);
          continue;
        }

        try {
          await withdrawListing(refreshToken, listing.ebay_offer_id);
        } catch (withdrawErr) {
          console.error(`[stock-monitor] Could not withdraw eBay listing ${listing.sku}; leaving it published for retry: ${withdrawErr.message}`);
          continue;
        }

        await updateListing(user.id, listing.id, {
          amazonInStock: false,
          lastStockSyncedAt: new Date(),
          lastStockCheckedAt: new Date(),
          markDraftCustomized: false,
        });
        await markEnded(user.id, listing.id, `Ended: out of stock on Amazon (${availability.availabilityText || 'unavailable'})`);

        console.log(`[stock-monitor] Listing ${listing.sku} ended on eBay and locally.`);
        continue; // it's ended - no point price-checking it too
      }

      // Still in stock - keep the eBay quantity at a conservative 1 because
      // the current Canopy response gives us availability (in/out of stock),
      // not an exact supplier quantity. This avoids inventing a supplier
      // quantity and reduces overselling risk. Once an exact quantity source
      // is available, this can be replaced with the real quantity.
      if (listing.stock_monitoring !== false) await syncStockQuantity(user, listing, availability);

      // Still in stock - check whether Amazon's price moved, and keep the
      // eBay price in sync (see syncPriceIfChanged below). This reuses the
      // availability response above, so it's not a second Canopy call and
      // not a second credit charge (ACTION_COSTS.PRICE_MONITORING is 0).
      if (listing.price_monitoring !== false) await syncPriceIfChanged(user, listing, availability);
    } catch (err) {
      // A failed check (rate limit, network issue, etc.) should not end the
      // listing - we just log it and try again on the next scheduled run.
      console.error(`[stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    }
  }
}


/**
 * Synchronizes a conservative eBay quantity for an item that Canopy reports
 * as in stock. Canopy currently exposes availability but not an exact
 * supplier quantity, so ELMS uses 1 rather than fabricating a larger number.
 *
 * The eBay API is only written when the state needs to change: the first
 * successful in-stock observation, a previous failed sync, or a local
 * quantity that is not the safe quantity. This keeps unnecessary listing
 * revisions low.
 */
async function syncStockQuantity(user, listing, availability) {
  if (!availability?.inStock || !listing.ebay_offer_id) return;

  const safeQuantity = 1;
  const alreadySyncedInStock = listing.amazon_in_stock === true;
  const localQuantity = Number(listing.quantity);

  if (alreadySyncedInStock && localQuantity === safeQuantity) {
    await updateListing(user.id, listing.id, {
      lastStockCheckedAt: new Date(),
      markDraftCustomized: false,
    });
    return;
  }

  const refreshToken = listing.ebay_account_id
    ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id)
    : null;

  if (!refreshToken) {
    console.warn(`[stock-monitor] Could not find the eBay account for listing ${listing.sku}; quantity sync will retry next run.`);
    return;
  }

  try {
    await updateOfferQuantity(refreshToken, listing.ebay_offer_id, safeQuantity);

    await updateListing(user.id, listing.id, {
      quantity: safeQuantity,
      amazonInStock: true,
      lastStockSyncedAt: new Date(),
      lastStockCheckedAt: new Date(),
      markDraftCustomized: false,
    });

    console.log(`[stock-monitor] ${listing.sku}: Amazon is in stock; eBay quantity synchronized to ${safeQuantity}.`);
  } catch (err) {
    // Do not record a successful sync when eBay rejected/timed out. The
    // unchanged state makes the next scheduled run retry automatically.
    console.error(`[stock-monitor] Could not sync eBay quantity for ${listing.sku}: ${err.message}`);
  }
}

/**
 * Keeps a published listing's eBay price in sync with Amazon, using the
 * price+stock data already fetched by runStockCheckForUser (no extra
 * Canopy call, no extra credit charge).
 *
 * Design: preserve the seller's exact cash margin (eBay sell price minus
 * Amazon price) from the previous check. For example, $100 Amazon -> $110
 * eBay keeps a $10 margin, so when Amazon becomes $110, eBay becomes $120.
 * The Amazon price baseline (Import.amazonPrice) is refreshed on every
 * check regardless of whether the eBay price actually moved, so the next
 * check compares against the immediately previous Amazon price.
 */
async function syncPriceIfChanged(user, listing, availability) {
  const newAmazonPrice = Number(availability.price);
  if (!Number.isFinite(newAmazonPrice) || newAmazonPrice <= 0) return;

  const oldAmazonPrice = Number(listing.amazon_price);
  const hasBaseline = Number.isFinite(oldAmazonPrice) && oldAmazonPrice > 0;
  const priceUnchanged = hasBaseline && Math.abs(newAmazonPrice - oldAmazonPrice) < 0.01;
  const margin = getSavedMargin(listing);

  try {
    if (!hasBaseline) {
      const baselineUpdate = {
        amazonPrice: newAmazonPrice,
        lastStockCheckedAt: new Date(),
      };
      if (margin == null && Number.isFinite(Number(listing.sell_price))) {
        baselineUpdate.marginAmount = Number((Number(listing.sell_price) - newAmazonPrice).toFixed(2));
      }
      await updateListing(user.id, listing.id, { ...baselineUpdate, markDraftCustomized: false });
      console.log(`[price-monitor] ${listing.sku}: established Amazon price baseline at ${newAmazonPrice}.`);
      return;
    }

    if (priceUnchanged) {
      await updateListing(user.id, listing.id, { lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    if (listing.repricing_enabled === false) {
      await updateListing(user.id, listing.id, { amazonPrice: newAmazonPrice, lastStockCheckedAt: new Date(), markDraftCustomized: false });
      console.log(`[price-monitor] ${listing.sku}: repricing disabled; recorded source price ${newAmazonPrice}.`);
      return;
    }

    if (!listing.ebay_offer_id || listing.sell_price == null) {
      await updateListing(user.id, listing.id, { amazonPrice: newAmazonPrice, lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    const effectiveMargin = margin != null
      ? margin
      : Number((Number(listing.sell_price) - oldAmazonPrice).toFixed(2));
    // A listing priced by a pricing rule is priced by that rule again; any other keeps its cash margin.
    const repriced = repriceFor(listing, newAmazonPrice, effectiveMargin);

    if (repriced == null) {
      console.error(`[price-monitor] ${listing.sku}: calculated eBay price is invalid (source=${newAmazonPrice}, margin=${effectiveMargin}); baseline retained for retry.`);
      return;
    }
    const newSellPrice = repriced.sellPrice;

    const refreshToken = listing.ebay_account_id
      ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id)
      : null;
    if (!refreshToken) {
      console.warn(`[price-monitor] Could not find the eBay account for listing ${listing.sku} (user ${user.id}); price baseline retained for retry.`);
      return;
    }

    // The offer is in the store's currency. The listing's price is in the Amazon site's currency, which is the same for a store
    // with an Amazon site of its own (UK, US, AU ...); for the rest the new price is converted, and with no exchange rate this
    // round is skipped (the baseline stays, so the next check retries) rather than put a number in the wrong currency.
    const storeCurrency = getMarketplaceConfig(listing.marketplace_id)?.currency || null;
    const draftCurrency = sourceCurrency(listing.amazon_url, listing.currency);
    let offerPrice = newSellPrice;
    if (storeCurrency && draftCurrency && storeCurrency !== draftCurrency) {
      offerPrice = (await convertAmount(newSellPrice, draftCurrency, storeCurrency)).amount;
    }

    await updateOfferPrice(refreshToken, listing.ebay_offer_id, offerPrice);

    await updateListing(user.id, listing.id, {
      sellPrice: newSellPrice,
      amazonPrice: newAmazonPrice,
      marginAmount: repriced.marginAmount,
      ...(repriced.rule ? { pricingRule: repriced.rule } : {}), // the rule stays with the listing (a plain price save would end it)
      lastRepricedAt: new Date(),
      lastStockCheckedAt: new Date(),
      markDraftCustomized: false,
    });

    console.log(`[price-monitor] ${listing.sku}: Amazon ${oldAmazonPrice} -> ${newAmazonPrice}, eBay ${listing.sell_price} -> ${newSellPrice}, ${repriced.rule ? 'by the pricing rule' : 'fixed margin ' + effectiveMargin}.`);
  } catch (err) {
    console.error(`[price-monitor] Could not update eBay price for ${listing.sku}: ${err.message}`);
  } finally {
    if (listing.import_id) await updateImportPrice(user.id, listing.import_id, newAmazonPrice).catch(() => {});
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

module.exports = { startStockMonitor, runStockCheck, runStockCheckForUser, supplierCountryOf };
