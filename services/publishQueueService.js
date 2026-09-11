const {
  listPublishingListings,
  getListingById,
  markPublished,
  markError,
  markPublishCreditCharged,
} = require('../models/listingsModel');
const { getImportById } = require('../models/importsModel');
const { getEbayAccountById, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { publishListing, createOrGetCustomLocation } = require('./ebayListingService');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { createSystemNotification } = require('../models/systemNotificationsModel');

function normalizeError(err) {
  return {
    code: err?.ebayErrors?.[0]?.errorId || err?.code || null,
    statusCode: err?.statusCode || null,
    message: err?.message || 'Could not publish this listing to eBay.',
    ebayErrors: Array.isArray(err?.ebayErrors) ? err.ebayErrors : [],
  };
}

async function processOneQueuedListing(listing) {
  const userId = listing.userId;
  const id = listing.id;
  let charged = !!listing.publish_credit_charged;

  try {
    if (!listing.ebay_account_id) throw new Error('No eBay account is assigned to this listing.');
    if (!listing.import_id) throw new Error('The draft has no linked Amazon product data.');
    if (!listing.category_id) throw new Error('No eBay category ID is set.');
    if (!listing.sell_price) throw new Error('No sell price is set.');

    const importRecord = await getImportById(userId, listing.import_id);
    if (!importRecord?.product) throw new Error('The linked Amazon product data could not be found.');

    const sellerSettings = await getEbayAccountById(userId, listing.ebay_account_id);
    if (!sellerSettings) throw new Error('The selected eBay account could not be found. Please reconnect it.');

    const refreshToken = await getEbayAccountRefreshToken(userId, listing.ebay_account_id);
    if (!refreshToken) throw new Error('The selected eBay account is not connected. Please reconnect it.');

    if (!charged) {
      if (!(await hasCredits(userId, ACTION_COSTS.EBAY_PUBLISH))) {
        const err = new Error(`Publish failed: not enough credits. This listing was not charged.`);
        err.statusCode = 402;
        throw err;
      }
      charged = await spendCredit(userId, ACTION_COSTS.EBAY_PUBLISH);
      if (!charged) throw new Error('Could not reserve a publish credit. Please try again.');
      await markPublishCreditCharged(userId, id, true);
    }

    if (sellerSettings.productLocationMode === 'custom' && sellerSettings.customCountryCode && sellerSettings.customPostalCode) {
      sellerSettings.merchantLocationKey = await createOrGetCustomLocation(refreshToken, sellerSettings.customCountryCode, sellerSettings.customPostalCode);
    }

    const product = {
      ...importRecord.product,
      title: listing.title || importRecord.product.title,
      images: listing.images_customized ? (listing.images || []) : (listing.images?.length ? listing.images : (importRecord.product.images || [])),
      ebayAspects: importRecord.product.ebayAspects || {},
    };

    const result = await publishListing({
      refreshToken,
      product,
      sellPrice: listing.sell_price,
      quantity: listing.quantity,
      categoryId: listing.category_id,
      sku: listing.sku,
      sellerSettings,
    });

    const updated = await markPublished(userId, id, {
      offerId: result.offerId,
      listingId: result.listingId,
      ebayAccountId: listing.ebay_account_id,
      publishResponse: result,
      ebayImageUrls: result.imageUrls || [],
    });

    await createSystemNotification(userId, {
      type: 'publish_success', level: 'success',
      title: 'Listing published',
      message: `${listing.title || listing.sku} is now live on eBay.`,
      listingId: id,
      metadata: { listingId: result.listingId || null, offerId: result.offerId || null, response: result },
    }).catch(() => {});

    return updated;
  } catch (err) {
    const details = normalizeError(err);
    if (charged) {
      await refundCredit(userId, ACTION_COSTS.EBAY_PUBLISH).catch(() => {});
    }
    await markPublishCreditCharged(userId, id, false).catch(() => {});
    const updated = await markError(userId, id, details.message, details);
    await createSystemNotification(userId, {
      type: 'publish_failed', level: 'error',
      title: 'Publish failed',
      message: `${listing.title || listing.sku}: ${details.message}`,
      listingId: id,
      metadata: details,
    }).catch(() => {});
    return updated;
  }
}

async function processPublishQueue() {
  const listings = await listPublishingListings(50);
  for (const listing of listings) {
    await processOneQueuedListing(listing);
  }
  return listings.length;
}

module.exports = { processPublishQueue, processOneQueuedListing };
