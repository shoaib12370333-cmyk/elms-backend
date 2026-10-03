const cron = require('node-cron');
const { checkAvailabilityByAsin, detectCountryFromUrl } = require('../services/canopyAmazonService');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { sourceCurrency } = require('../config/amazonDomains');
const { convertAmount } = require('../services/currencyService');
const { withdrawListing, updateOfferPrice, updateOfferQuantity, isAccountBlockedError } = require('../services/ebayListingService');
const { getSavedMargin, repriceFor } = require('../services/repricingService');
const { listPublishedListings, markEnded, updateListing } = require('../models/listingsModel');
const { updateImportPrice } = require('../models/importsModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { createSystemNotification } = require('../models/systemNotificationsModel');
const { acquireLock } = require('../services/jobLockService');
const { ACTION_COSTS } = require('../config/actionCosts');
const cjAdapter = require('../services/cjAdapter');
const aliexpressAdapter = require('../services/aliexpressAdapter');
const { destCountryFor } = require('../services/cjImportService');
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
 * eBay blocking the whole account (see services/ebayListingService.js isAccountBlockedError) would otherwise fail
 * the SAME way for every published listing's withdraw/quantity/price write, every run, with nothing but a
 * console.error the seller never sees (compare services/publishQueueService.js, which tells the seller in-app the
 * moment a manual publish fails). `state` is one plain object per call to runStockCheckForUser, so this still fires
 * only once per day per user no matter how many listings or writes hit it in that one run.
 */
async function notifyAccountBlockedOnce(user, err, state) {
  if (state.notified || !isAccountBlockedError(err)) return;
  state.notified = true;
  await createSystemNotification(user.id, {
    type: 'ebay_account_blocked',
    level: 'error',
    title: 'eBay has paused this store',
    message: err.message,
  }).catch(() => {});
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
  const blockState = { notified: false };

  for (const listing of publishedListings) {
    // Both monitors switched off for this product in the listing editor: skip it (and save the credit).
    if (listing.stock_monitoring === false && listing.price_monitoring === false) continue;

    // CJdropshipping listings never touch Canopy/checkAvailabilityByAsin (Amazon-only): they go through their own function,
    // which uses only services/cjAdapter.js and its own credit key (ACTION_COSTS.CJ_STOCK_MONITORING).
    if (listing.source_platform === 'cj') {
      const keepGoing = await checkCjListing(user, listing, blockState);
      if (!keepGoing) break;
      continue;
    }

    // AliExpress listings likewise have their own function and credit key (ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING), and only
    // ever call services/aliexpressAdapter.js - never Canopy or CJ.
    if (listing.source_platform === 'aliexpress') {
      const keepGoing = await checkAliexpressListing(user, listing, blockState);
      if (!keepGoing) break;
      continue;
    }

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
          await notifyAccountBlockedOnce(user, withdrawErr, blockState);
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
      if (listing.stock_monitoring !== false) await syncStockQuantity(user, listing, availability, blockState);

      // Still in stock - check whether Amazon's price moved, and keep the
      // eBay price in sync (see syncPriceIfChanged below). This reuses the
      // availability response above, so it's not a second Canopy call and
      // not a second credit charge (ACTION_COSTS.PRICE_MONITORING is 0).
      if (listing.price_monitoring !== false) await syncPriceIfChanged(user, listing, availability, blockState);
    } catch (err) {
      // A failed check (rate limit, network issue, etc.) should not end the
      // listing - we just log it and try again on the next scheduled run.
      console.error(`[stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    }
  }

  await notifyAliexpressProblems(user, blockState);
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
async function syncStockQuantity(user, listing, availability, blockState) {
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
    await notifyAccountBlockedOnce(user, err, blockState);
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
async function syncPriceIfChanged(user, listing, availability, blockState) {
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
    await notifyAccountBlockedOnce(user, err, blockState);
  } finally {
    if (listing.import_id) await updateImportPrice(user.id, listing.import_id, newAmazonPrice).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// CJdropshipping stock + price monitor. Its own functions, its own credit key (ACTION_COSTS.CJ_STOCK_MONITORING, never
// STOCK_MONITORING/PRICE_MONITORING) - only services/cjAdapter.js is called here, never Canopy/Easyparser.
// ---------------------------------------------------------------------------------------------------------------------------

/** Every warehouse's stock added up - "is this variant sellable at all", not just in the buyer's own country. */
function cjTotalInventory(variant) {
  return (variant.inventories || []).reduce((sum, i) => sum + (Number(i.totalInventory) || 0), 0);
}

/** The warehouse country CJ should ship this variant from: whichever holds the most stock (falls back to CN, CJ's usual origin, when nothing is reported). Used as the freight quote's startCountryCode. */
function cjPrimaryWarehouse(variant) {
  const rows = variant.inventories || [];
  if (!rows.length) return 'CN';
  return rows.reduce((best, r) => (Number(r.totalInventory) > Number(best.totalInventory) ? r : best), rows[0]).countryCode || 'CN';
}

/**
 * Checks one CJ-sourced published listing: ends it on eBay when CJ is out of stock everywhere, otherwise keeps the eBay
 * quantity in sync with CJ's real number and, when the CJ price (or a stale/missing shipping quote) has moved, reprices it -
 * the CJ counterpart of the Amazon in-stock/price branch above, using only services/cjAdapter.js.
 * @returns {Promise<boolean>} false when the user is out of credits (the caller stops checking this user's remaining listings)
 */
async function checkCjListing(user, listing, blockState) {
  if (!listing.cj_product_id || !listing.cj_variant_id) {
    console.warn(`[cj-stock-monitor] Listing ${listing.id} (SKU ${listing.sku}) has no CJ ids, skipping.`);
    return true;
  }

  if (!(await spendCredit(user.id, ACTION_COSTS.CJ_STOCK_MONITORING))) {
    console.warn(`[cj-stock-monitor] ${user.email} ran out of credits mid-check; remaining listings will be checked next time they're due.`);
    return false;
  }

  try {
    let detail;
    try {
      detail = await cjAdapter.getProductDetail(user.id, { pid: listing.cj_product_id });
    } catch (err) {
      await refundCredit(user.id, ACTION_COSTS.CJ_STOCK_MONITORING).catch((e) => console.error(`[credits] REFUND FAILED for user ${user.id}: ${e.message}`));
      throw err;
    }
    const variant = detail.variants.find((v) => v.vid === listing.cj_variant_id);
    if (!variant) {
      console.warn(`[cj-stock-monitor] ${listing.sku}: CJ no longer lists this variant.`);
      return true;
    }

    const inventory = cjTotalInventory(variant);

    if (inventory <= 0 && listing.stock_monitoring !== false) {
      console.log(`[cj-stock-monitor] ${listing.sku} is out of stock on CJdropshipping. Ending eBay listing...`);
      if (!listing.ebay_offer_id) {
        await markEnded(user.id, listing.id, 'Ended: out of stock on CJdropshipping');
        return true;
      }
      const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
      if (!refreshToken) {
        console.warn(`[cj-stock-monitor] Could not find the eBay account for listing ${listing.sku}; leaving it published so withdrawal can be retried.`);
        return true;
      }
      try {
        await withdrawListing(refreshToken, listing.ebay_offer_id);
      } catch (withdrawErr) {
        console.error(`[cj-stock-monitor] Could not withdraw eBay listing ${listing.sku}; leaving it published for retry: ${withdrawErr.message}`);
        await notifyAccountBlockedOnce(user, withdrawErr, blockState);
        return true;
      }
      await updateListing(user.id, listing.id, { amazonInStock: false, lastStockSyncedAt: new Date(), lastStockCheckedAt: new Date(), markDraftCustomized: false });
      await markEnded(user.id, listing.id, 'Ended: out of stock on CJdropshipping');
      console.log(`[cj-stock-monitor] Listing ${listing.sku} ended on eBay and locally.`);
      return true;
    }

    if (listing.stock_monitoring !== false) await syncCjStockQuantity(user, listing, inventory, blockState);
    if (listing.price_monitoring !== false) await syncCjPriceIfChanged(user, listing, variant, blockState);
    return true;
  } catch (err) {
    console.error(`[cj-stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    return true;
  }
}

/** Keeps eBay's quantity equal to CJ's real inventory (unlike Amazon, CJ gives an exact number, not just in/out of stock) - capped at 999 defensively, so a warehouse count in the tens of thousands never gets sent to eBay as-is. */
async function syncCjStockQuantity(user, listing, inventory, blockState) {
  if (!listing.ebay_offer_id) return;
  const safeQuantity = Math.min(inventory, 999);
  if (listing.amazon_in_stock === true && Number(listing.quantity) === safeQuantity) {
    await updateListing(user.id, listing.id, { lastStockCheckedAt: new Date(), markDraftCustomized: false });
    return;
  }
  const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
  if (!refreshToken) {
    console.warn(`[cj-stock-monitor] Could not find the eBay account for listing ${listing.sku}; quantity sync will retry next run.`);
    return;
  }
  try {
    await updateOfferQuantity(refreshToken, listing.ebay_offer_id, safeQuantity);
    await updateListing(user.id, listing.id, { quantity: safeQuantity, amazonInStock: true, lastStockSyncedAt: new Date(), lastStockCheckedAt: new Date(), markDraftCustomized: false });
    console.log(`[cj-stock-monitor] ${listing.sku}: CJ has ${inventory} in stock; eBay quantity synchronized to ${safeQuantity}.`);
  } catch (err) {
    console.error(`[cj-stock-monitor] Could not sync eBay quantity for ${listing.sku}: ${err.message}`);
    await notifyAccountBlockedOnce(user, err, blockState);
  }
}

/**
 * Keeps a CJ-sourced listing's eBay price (and its saved CJ shipping cost) in sync, the CJ counterpart of syncPriceIfChanged
 * above: the same "keep the seller's exact cash margin, or reprice by their saved rule" logic (services/repricingService.js),
 * but the source cost also includes CJ's own shipping quote (Listing.cjShippingCost - models/listingsModel.js
 * listingProfitAmount), requoted here so it never goes stale.
 */
async function syncCjPriceIfChanged(user, listing, variant, blockState) {
  const newSourcePrice = Number(variant.variantSellPrice);
  if (!Number.isFinite(newSourcePrice) || newSourcePrice <= 0) return;

  const destCountry = destCountryFor(listing.marketplace_id);
  const freight = await cjAdapter.calcFreight(user.id, { vid: variant.vid, quantity: 1, startCountryCode: cjPrimaryWarehouse(variant), endCountryCode: destCountry }).catch(() => null);
  const newShippingCost = freight ? freight.cost : listing.cj_shipping_cost;

  const oldSourcePrice = Number(listing.amazon_price);
  const oldShippingCost = Number(listing.cj_shipping_cost) || 0;
  const hasBaseline = Number.isFinite(oldSourcePrice) && oldSourcePrice > 0;
  const unchanged = hasBaseline && Math.abs(newSourcePrice - oldSourcePrice) < 0.01 && Math.abs((Number(newShippingCost) || 0) - oldShippingCost) < 0.01;
  const margin = getSavedMargin(listing);

  try {
    if (!hasBaseline) {
      const baselineUpdate = { amazonPrice: newSourcePrice, cjShippingCost: newShippingCost, lastStockCheckedAt: new Date() };
      if (margin == null && Number.isFinite(Number(listing.sell_price))) {
        baselineUpdate.marginAmount = Number((Number(listing.sell_price) - newSourcePrice - (Number(newShippingCost) || 0)).toFixed(2));
      }
      await updateListing(user.id, listing.id, { ...baselineUpdate, markDraftCustomized: false });
      console.log(`[cj-price-monitor] ${listing.sku}: established CJ price baseline at ${newSourcePrice} (shipping ${newShippingCost ?? 'unknown'}).`);
      return;
    }

    if (unchanged) {
      await updateListing(user.id, listing.id, { lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    if (listing.repricing_enabled === false || !listing.ebay_offer_id || listing.sell_price == null) {
      await updateListing(user.id, listing.id, { amazonPrice: newSourcePrice, cjShippingCost: newShippingCost, lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    const effectiveMargin = margin != null ? margin : Number((Number(listing.sell_price) - oldSourcePrice - oldShippingCost).toFixed(2));
    // The listing's own margin already accounts for the old shipping cost, so the new "source price" repriceFor sees is the
    // CJ price plus its own shipping - the same total cost basis listingProfitAmount uses.
    const repriced = repriceFor(listing, newSourcePrice + (Number(newShippingCost) || 0), effectiveMargin);
    if (repriced == null) {
      console.error(`[cj-price-monitor] ${listing.sku}: calculated eBay price is invalid; baseline retained for retry.`);
      return;
    }

    const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
    if (!refreshToken) {
      console.warn(`[cj-price-monitor] Could not find the eBay account for listing ${listing.sku} (user ${user.id}); price baseline retained for retry.`);
      return;
    }

    const storeCurrency = getMarketplaceConfig(listing.marketplace_id)?.currency || null;
    // Every CJ price is quoted in USD (CJ docs), unlike Amazon where the draft's own currency already matches the source site.
    let offerPrice = repriced.sellPrice;
    if (storeCurrency && storeCurrency !== 'USD') {
      offerPrice = (await convertAmount(repriced.sellPrice, 'USD', storeCurrency)).amount;
    }

    await updateOfferPrice(refreshToken, listing.ebay_offer_id, offerPrice);
    await updateListing(user.id, listing.id, {
      sellPrice: repriced.sellPrice,
      amazonPrice: newSourcePrice,
      cjShippingCost: newShippingCost,
      marginAmount: repriced.marginAmount,
      ...(repriced.rule ? { pricingRule: repriced.rule } : {}),
      lastRepricedAt: new Date(),
      lastStockCheckedAt: new Date(),
      markDraftCustomized: false,
    });
    console.log(`[cj-price-monitor] ${listing.sku}: CJ ${oldSourcePrice} -> ${newSourcePrice} (shipping ${oldShippingCost} -> ${newShippingCost ?? 'unknown'}), eBay ${listing.sell_price} -> ${repriced.sellPrice}.`);
  } catch (err) {
    console.error(`[cj-price-monitor] Could not update eBay price for ${listing.sku}: ${err.message}`);
    await notifyAccountBlockedOnce(user, err, blockState);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// AliExpress stock + price monitor. Its own functions, its own credit key (ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING, never
// STOCK_MONITORING/PRICE_MONITORING/CJ_STOCK_MONITORING) - only services/aliexpressAdapter.js is called here. It reads the same
// aliexpress.ds.product.get answer the import reads (sku_available_stock, offer_sale_price / sku_price, currency_code), for the
// ONE sku the listing was imported from, priced for the store's own country exactly like the import did.
// ---------------------------------------------------------------------------------------------------------------------------

// After this many AliExpress calls in a row fail inside one user's run (a dead or revoked token, AliExpress down), the rest of
// that user's AliExpress listings are left for the next run instead of each being charged, failed and refunded.
const ALIEXPRESS_MAX_CONSECUTIVE_FAILURES = 3;

// How one sku's stock and price are read is shared with the order service (services/aliexpressSkuHelpers.js).
const { skuStock: aliexpressSkuStock, skuPrice: aliexpressSkuPrice } = require('../services/aliexpressSkuHelpers');

/**
 * Withdraws a published listing's eBay offer because its supplier has run out, then marks it ended here. The listing is never
 * marked ended locally when the eBay offer could not be withdrawn (ELMS would say "ended" while eBay keeps selling it): it stays
 * published and the next run retries.
 */
async function endListingBecauseSupplierOutOfStock(user, listing, reason, blockState, logTag) {
  if (!listing.ebay_offer_id) {
    await markEnded(user.id, listing.id, reason);
    return;
  }
  const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
  if (!refreshToken) {
    console.warn(`[${logTag}] Could not find the eBay account for listing ${listing.sku}; leaving it published so withdrawal can be retried.`);
    return;
  }
  try {
    await withdrawListing(refreshToken, listing.ebay_offer_id);
  } catch (withdrawErr) {
    console.error(`[${logTag}] Could not withdraw eBay listing ${listing.sku}; leaving it published for retry: ${withdrawErr.message}`);
    await notifyAccountBlockedOnce(user, withdrawErr, blockState);
    return;
  }
  await updateListing(user.id, listing.id, { amazonInStock: false, lastStockSyncedAt: new Date(), lastStockCheckedAt: new Date(), markDraftCustomized: false });
  await markEnded(user.id, listing.id, reason);
  console.log(`[${logTag}] Listing ${listing.sku} ended on eBay and locally.`);
}

/**
 * Tells the seller, once per run, about the two AliExpress problems the monitor cannot fix itself: AliExpress not answering for them
 * (a dead or revoked connection - the rest of the run's AliExpress listings were skipped) and products AliExpress no longer has
 * (still live on eBay, so the seller has to decide). Without this the monitoring would simply stop, with nothing to see.
 */
async function notifyAliexpressProblems(user, blockState) {
  if ((blockState.aliexpressFailures || 0) >= ALIEXPRESS_MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[aliexpress-stock-monitor] ${user.email}: AliExpress failed ${ALIEXPRESS_MAX_CONSECUTIVE_FAILURES} times in a row; the rest of this run's AliExpress listings were skipped.`);
    await createSystemNotification(user.id, {
      type: 'aliexpress_unavailable',
      level: 'warning',
      title: 'AliExpress stock monitoring paused',
      message: 'ELMS could not reach AliExpress for your account several times in a row, so the rest of your AliExpress listings were not checked this time. If this keeps happening, reconnect AliExpress in Settings.',
    }).catch(() => {});
  }
  const missing = blockState.aliexpressMissing || [];
  if (missing.length) {
    const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` and ${missing.length - 5} more` : '');
    await createSystemNotification(user.id, {
      type: 'aliexpress_product_missing',
      level: 'warning',
      title: 'AliExpress no longer has some of your products',
      message: `AliExpress could not find ${missing.length} product(s) you are selling (${shown}). They are still live on eBay - check them on AliExpress, and end them here if they are gone.`,
    }).catch(() => {});
  }
}

/**
 * Checks one AliExpress-sourced published listing: ends it on eBay when its sku is out of stock on AliExpress, otherwise keeps the
 * eBay quantity in sync with AliExpress's real number and reprices it when the AliExpress price moved - the AliExpress counterpart
 * of checkCjListing above. A sku AliExpress no longer lists, or a stock figure AliExpress did not give, is left alone (logged),
 * never read as "out of stock".
 * @returns {Promise<boolean>} false when the user is out of credits (the caller stops checking this user's remaining listings)
 */
async function checkAliexpressListing(user, listing, blockState) {
  if (!listing.aliexpress_product_id || !listing.aliexpress_sku_id) {
    console.warn(`[aliexpress-stock-monitor] Listing ${listing.id} (SKU ${listing.sku}) has no AliExpress ids, skipping.`);
    return true;
  }
  if ((blockState.aliexpressFailures || 0) >= ALIEXPRESS_MAX_CONSECUTIVE_FAILURES) return true; // AliExpress is not answering for this seller right now - see above

  if (!(await spendCredit(user.id, ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING))) {
    console.warn(`[aliexpress-stock-monitor] ${user.email} ran out of credits mid-check; remaining listings will be checked next time they're due.`);
    return false;
  }

  try {
    let detail;
    try {
      detail = await aliexpressAdapter.getProductDetail(user.id, {
        productId: listing.aliexpress_product_id,
        shipToCountry: getMarketplaceConfig(listing.marketplace_id)?.country || 'US', // the same country the import priced it for
        targetCurrency: listing.currency || 'USD',
      });
    } catch (err) {
      await refundCredit(user.id, ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING).catch((e) => console.error(`[credits] REFUND FAILED for user ${user.id}: ${e.message}`));
      if (err.productMissing) {
        // AliExpress answered: this product is gone. That is not an outage (it must not count toward giving up on the rest of the
        // run) - but it is not safe to end the listing on it either while the answer's shape is unconfirmed, so the seller is told instead.
        (blockState.aliexpressMissing = blockState.aliexpressMissing || []).push(listing.sku);
      } else {
        blockState.aliexpressFailures = (blockState.aliexpressFailures || 0) + 1;
      }
      throw err;
    }
    blockState.aliexpressFailures = 0;

    // Exactly ONE sku must match: sku ids are large numbers, and should two siblings ever read as the same id, the first one's stock
    // must not decide whether THIS listing is ended.
    const skus = Array.isArray(detail.ae_item_sku_info_dtos) ? detail.ae_item_sku_info_dtos : [];
    const matches = skus.filter((s) => String(s.sku_id) === String(listing.aliexpress_sku_id));
    const sku = matches.length === 1 ? matches[0] : null;
    if (!sku) {
      // Nothing was learned, so nothing is charged (if a field name were wrong, every listing would otherwise burn a credit a day for nothing).
      await refundCredit(user.id, ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING).catch((e) => console.error(`[credits] REFUND FAILED for user ${user.id}: ${e.message}`));
      console.warn(matches.length > 1
        ? `[aliexpress-stock-monitor] ${listing.sku}: AliExpress lists more than one sku with this id; leaving the listing as it is.`
        : `[aliexpress-stock-monitor] ${listing.sku}: AliExpress no longer lists this sku; leaving the listing as it is.`);
      return true;
    }

    const stock = aliexpressSkuStock(sku);
    if (stock === null && aliexpressSkuPrice(sku) === null) {
      await refundCredit(user.id, ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING).catch((e) => console.error(`[credits] REFUND FAILED for user ${user.id}: ${e.message}`));
      console.warn(`[aliexpress-stock-monitor] ${listing.sku}: AliExpress gave neither a stock figure nor a price for this sku; leaving the listing as it is.`);
      return true;
    }
    if (stock === null) {
      console.warn(`[aliexpress-stock-monitor] ${listing.sku}: AliExpress gave no stock figure for this sku; leaving the listing as it is.`);
    } else if (stock <= 0 && listing.stock_monitoring !== false) {
      console.log(`[aliexpress-stock-monitor] ${listing.sku} is out of stock on AliExpress. Ending eBay listing...`);
      await endListingBecauseSupplierOutOfStock(user, listing, 'Ended: out of stock on AliExpress', blockState, 'aliexpress-stock-monitor');
      return true; // ended (or left for a retry): no point price-checking it too
    } else if (listing.stock_monitoring !== false) {
      await syncAliexpressStockQuantity(user, listing, stock, blockState);
    }

    await refreshAliexpressShipping(user, listing);
    if (listing.price_monitoring !== false) await syncAliexpressPriceIfChanged(user, listing, sku, detail, blockState);
    return true;
  } catch (err) {
    console.error(`[aliexpress-stock-monitor] Could not check stock for ${listing.sku}: ${err.message}`);
    return true;
  }
}

/**
 * Re-quotes the AliExpress shipping for a listing's sku and keeps the figure on the listing current, so the profit shown stays
 * honest. Deliberately does NOT reprice: the eBay price follows the AliExpress item price only (as the CJ monitor's margin logic
 * would otherwise push the whole shipping cost into the first price change). A failed quote leaves the last good figure alone.
 */
async function refreshAliexpressShipping(user, listing) {
  try {
    const quote = await aliexpressAdapter.quoteShipping(user.id, {
      productId: listing.aliexpress_product_id,
      skuId: listing.aliexpress_sku_id,
      shipToCountry: getMarketplaceConfig(listing.marketplace_id)?.country || 'US',
      currency: listing.currency || 'USD',
    });
    if (!quote) return;
    const before = listing.aliexpress_delivery || {};
    // != null first: Number(null) is 0, which would make a free quote look "unchanged" from a listing that was never quoted.
    const unchanged = listing.aliexpress_shipping_cost != null && Number(listing.aliexpress_shipping_cost) === quote.cost && (before.min_days ?? null) === (quote.minDays ?? null) && (before.max_days ?? null) === (quote.maxDays ?? null);
    if (unchanged) return;
    await updateListing(user.id, listing.id, { aliexpressShipping: quote, markDraftCustomized: false });
    console.log(`[aliexpress-stock-monitor] ${listing.sku}: shipping ${listing.aliexpress_shipping_cost ?? 'unknown'} -> ${quote.cost} ${quote.currency || ''}`.trim());
  } catch (err) {
    console.warn(`[aliexpress-stock-monitor] Could not refresh the shipping quote for ${listing.sku}: ${err.message}`);
  }
}

/** Keeps eBay's quantity equal to AliExpress's real stock for the sku (like CJ, an exact number, not just in/out of stock) - capped at 999 defensively. */
async function syncAliexpressStockQuantity(user, listing, stock, blockState) {
  if (!listing.ebay_offer_id) return;
  const safeQuantity = Math.min(stock, 999);
  if (listing.amazon_in_stock === true && Number(listing.quantity) === safeQuantity) {
    await updateListing(user.id, listing.id, { lastStockCheckedAt: new Date(), markDraftCustomized: false });
    return;
  }
  const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
  if (!refreshToken) {
    console.warn(`[aliexpress-stock-monitor] Could not find the eBay account for listing ${listing.sku}; quantity sync will retry next run.`);
    return;
  }
  try {
    await updateOfferQuantity(refreshToken, listing.ebay_offer_id, safeQuantity);
    await updateListing(user.id, listing.id, { quantity: safeQuantity, amazonInStock: true, lastStockSyncedAt: new Date(), lastStockCheckedAt: new Date(), markDraftCustomized: false });
    console.log(`[aliexpress-stock-monitor] ${listing.sku}: AliExpress has ${stock} in stock; eBay quantity synchronized to ${safeQuantity}.`);
  } catch (err) {
    console.error(`[aliexpress-stock-monitor] Could not sync eBay quantity for ${listing.sku}: ${err.message}`);
    await notifyAccountBlockedOnce(user, err, blockState);
  }
}

/**
 * Keeps an AliExpress-sourced listing's eBay price in sync, the AliExpress counterpart of syncCjPriceIfChanged above (without a
 * shipping quote: AliExpress has none stored on the listing): the same "keep the seller's exact cash margin, or reprice by their
 * saved rule" logic (services/repricingService.js). A price AliExpress quoted in another currency than the listing's baseline is
 * never compared with it - that round is skipped and the baseline stays.
 */
async function syncAliexpressPriceIfChanged(user, listing, sku, detail, blockState) {
  const newSourcePrice = aliexpressSkuPrice(sku);
  if (newSourcePrice === null) return;

  const quotedIn = String(sku.currency_code || detail.ae_item_base_info_dto?.currency_code || '').toUpperCase();
  const draftCurrency = String(listing.currency || 'USD').toUpperCase();
  if (quotedIn && quotedIn !== draftCurrency) {
    console.warn(`[aliexpress-price-monitor] ${listing.sku}: AliExpress quoted ${quotedIn}, the listing is in ${draftCurrency}; skipping the price check this round.`);
    return;
  }

  const oldSourcePrice = Number(listing.amazon_price);
  const hasBaseline = Number.isFinite(oldSourcePrice) && oldSourcePrice > 0;
  const unchanged = hasBaseline && Math.abs(newSourcePrice - oldSourcePrice) < 0.01;
  const margin = getSavedMargin(listing);

  try {
    if (!hasBaseline) {
      const baselineUpdate = { amazonPrice: newSourcePrice, lastStockCheckedAt: new Date() };
      if (margin == null && Number.isFinite(Number(listing.sell_price))) {
        baselineUpdate.marginAmount = Number((Number(listing.sell_price) - newSourcePrice).toFixed(2));
      }
      await updateListing(user.id, listing.id, { ...baselineUpdate, markDraftCustomized: false });
      console.log(`[aliexpress-price-monitor] ${listing.sku}: established AliExpress price baseline at ${newSourcePrice}.`);
      return;
    }

    if (unchanged) {
      await updateListing(user.id, listing.id, { lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    if (listing.repricing_enabled === false || !listing.ebay_offer_id || listing.sell_price == null) {
      await updateListing(user.id, listing.id, { amazonPrice: newSourcePrice, lastStockCheckedAt: new Date(), markDraftCustomized: false });
      return;
    }

    const effectiveMargin = margin != null ? margin : Number((Number(listing.sell_price) - oldSourcePrice).toFixed(2));
    const repriced = repriceFor(listing, newSourcePrice, effectiveMargin);
    if (repriced == null) {
      console.error(`[aliexpress-price-monitor] ${listing.sku}: calculated eBay price is invalid; baseline retained for retry.`);
      return;
    }

    const refreshToken = listing.ebay_account_id ? await getEbayAccountRefreshToken(user.id, listing.ebay_account_id) : null;
    if (!refreshToken) {
      console.warn(`[aliexpress-price-monitor] Could not find the eBay account for listing ${listing.sku} (user ${user.id}); price baseline retained for retry.`);
      return;
    }

    // The offer is in the store's currency; the listing's price is in the currency it was imported in (AliExpress was asked for it).
    const storeCurrency = getMarketplaceConfig(listing.marketplace_id)?.currency || null;
    let offerPrice = repriced.sellPrice;
    if (storeCurrency && storeCurrency !== draftCurrency) {
      offerPrice = (await convertAmount(repriced.sellPrice, draftCurrency, storeCurrency)).amount;
    }

    await updateOfferPrice(refreshToken, listing.ebay_offer_id, offerPrice);
    await updateListing(user.id, listing.id, {
      sellPrice: repriced.sellPrice,
      amazonPrice: newSourcePrice,
      marginAmount: repriced.marginAmount,
      ...(repriced.rule ? { pricingRule: repriced.rule } : {}),
      lastRepricedAt: new Date(),
      lastStockCheckedAt: new Date(),
      markDraftCustomized: false,
    });
    console.log(`[aliexpress-price-monitor] ${listing.sku}: AliExpress ${oldSourcePrice} -> ${newSourcePrice}, eBay ${listing.sell_price} -> ${repriced.sellPrice}.`);
  } catch (err) {
    console.error(`[aliexpress-price-monitor] Could not update eBay price for ${listing.sku}: ${err.message}`);
    await notifyAccountBlockedOnce(user, err, blockState);
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

module.exports = { startStockMonitor, runStockCheck, runStockCheckForUser, supplierCountryOf, checkCjListing, cjTotalInventory, cjPrimaryWarehouse, checkAliexpressListing, aliexpressSkuStock, aliexpressSkuPrice };
