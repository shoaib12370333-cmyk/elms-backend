const {
  listPublishingListings,
  acquirePublishLease,
  getListingById,
  markPublished,
  markError,
  markPublishCreditCharged,
  updateListing,
} = require('../models/listingsModel');
const { ensureDraftCategory } = require('./draftCategoryService');

const { getImportById } = require('../models/importsModel');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { prepareAspects, assertUsableCategory } = require('./publishPreflightService');
const { extractPackageInfo, toEbayPackageWeightAndSize } = require('./packageInfoService');
const { convertAmount } = require('./currencyService');
const { sourceCurrency } = require('../config/amazonDomains');

const {
  getEbayAccountById,
  getEbayAccountRefreshToken,
} = require('../models/ebayAccountsModel');

const {
  publishListing,
  createOrGetCustomLocation,
  fulfillmentPolicyUsesCalculatedShipping,
} = require('./ebayListingService');

const {
  hasCredits,
  spendCredit,
  refundCredit,
} = require('../models/usersModel');

const { ACTION_COSTS } = require('../config/actionCosts');

const {
  createSystemNotification,
} = require('../models/systemNotificationsModel');


/**
 * eBay answers now and then with "A system error has occurred" (error 25001) or a 502/503/504 that goes
 * away on its own. publishListing is safe to run again (the inventory item is a PUT, an existing offer is
 * found and reused), so a transient failure is retried once, on a shorter deadline, before the publish
 * is reported as failed.
 */
function isTransientEbayError(err) {
  const id = Number(err?.ebayErrors?.[0]?.errorId);
  return id === 25001 || [502, 503, 504].includes(Number(err?.statusCode));
}

async function publishWithTransientRetry(publishFn, args, { delayMs = 3000, log = () => {} } = {}) {
  try {
    return await publishFn(args);
  } catch (err) {
    if (!isTransientEbayError(err)) throw err;
    log('TRANSIENT EBAY ERROR - retrying once', { message: err.message });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return publishFn({ ...args, timeoutMs: 2 * 60 * 1000 });
  }
}

function normalizeError(err) {
  return {
    code:
      err?.ebayErrors?.[0]?.errorId ||
      err?.code ||
      null,

    statusCode:
      err?.statusCode ||
      null,

    message:
      err?.message ||
      'Could not publish this listing to eBay.',

    ebayErrors:
      Array.isArray(err?.ebayErrors)
        ? err.ebayErrors
        : [],
  };
}


async function processOneQueuedListing(listing) {
  const userId = listing.userId;
  const id = listing.id;

  // One worker per listing. The instant publish, the background runner and the once-a-minute queue all come through here, and a
  // listing stays "publishing" the whole time it is being worked on, so without this two of them publish it at once (a double credit,
  // two "published" notifications, or one of them failing and giving the credit back while the listing is live).
  // Whoever does not get the lease leaves the listing to the one that has it. The leased copy is also the freshest one: a snapshot
  // taken a moment earlier may not know yet that the credit was charged.
  const leased = await acquirePublishLease(userId, id);
  if (!leased) return (await getListingById(userId, id)) || listing;
  listing = leased;

  let charged =
    !!listing.publish_credit_charged;

  let publishStage = 'START';


  const debug = (message, data) => {
    console.log(
      `[PUBLISH] ${message}`,
      data ?? ''
    );
  };


  try {
    // =========================================================
    // START
    // =========================================================

    debug('START', {
      listingId: id,
      sku: listing.sku || null,
    });


    // =========================================================
    // VALIDATION
    // =========================================================

    publishStage = 'VALIDATION';


    if (!listing.ebay_account_id) {
      throw new Error(
        'No eBay account is assigned to this listing.'
      );
    }


    if (!listing.import_id) {
      throw new Error(
        'The draft has no linked Amazon product data.'
      );
    }


    if (!listing.category_id) {
      // No category saved (the Drafts page only suggests one for the cards it shows): take eBay's suggestion for the title, save it on
      // the draft and go on, instead of failing every draft that never got one.
      const found = await ensureDraftCategory(userId, listing, { save: updateListing });
      listing.category_id = found.categoryId;
      debug('CATEGORY SUGGESTED', { listingId: id, categoryId: found.categoryId, name: found.categoryName });
    }


    if (!listing.sell_price) {
      throw new Error(
        'No sell price is set.'
      );
    }


    debug('VALIDATION PASSED');


    // =========================================================
    // LOAD AMAZON PRODUCT
    // =========================================================

    publishStage = 'LOAD_PRODUCT';


    const importRecord =
      await getImportById(
        userId,
        listing.import_id
      );


    if (!importRecord?.product) {
      throw new Error(
        'The linked Amazon product data could not be found.'
      );
    }


    debug('PRODUCT LOADED', {
      asin:
        importRecord.product.asin ||
        null,

      imageCount:
        Array.isArray(
          importRecord.product.images
        )
          ? importRecord.product.images.length
          : 0,
    });


    // =========================================================
    // LOAD EBAY ACCOUNT
    // =========================================================

    publishStage =
      'LOAD_EBAY_ACCOUNT';


    const sellerSettings =
      await getEbayAccountById(
        userId,
        listing.ebay_account_id
      );


    if (!sellerSettings) {
      throw new Error(
        'The selected eBay account could not be found. Please reconnect it.'
      );
    }


    debug(
      'EBAY ACCOUNT LOADED',
      {
        marketplaceId:
          sellerSettings.marketplaceId ||
          null,

        productLocationMode:
          sellerSettings.productLocationMode ||
          null,
      }
    );


    // =========================================================
    // LOAD EBAY REFRESH TOKEN
    // =========================================================

    publishStage =
      'LOAD_EBAY_TOKEN';


    const refreshToken =
      await getEbayAccountRefreshToken(
        userId,
        listing.ebay_account_id
      );


    if (!refreshToken) {
      throw new Error(
        'The selected eBay account is not connected. Please reconnect it.'
      );
    }


    debug(
      'EBAY REFRESH TOKEN AVAILABLE'
    );


    // =========================================================
    // CREDIT
    // =========================================================

    publishStage = 'CREDIT';


    if (!charged) {

      if (
        !(await hasCredits(
          userId,
          ACTION_COSTS.EBAY_PUBLISH
        ))
      ) {
        const err =
          new Error(
            'Publish failed: not enough credits. This listing was not charged.'
          );

        err.statusCode = 402;

        throw err;
      }


      charged =
        await spendCredit(
          userId,
          ACTION_COSTS.EBAY_PUBLISH
        );


      if (!charged) {
        throw new Error(
          'Could not reserve a publish credit. Please try again.'
        );
      }


      await markPublishCreditCharged(
        userId,
        id,
        true
      );


      debug(
        'PUBLISH CREDIT CHARGED',
        {
          amount:
            ACTION_COSTS.EBAY_PUBLISH,
        }
      );

    } else {

      debug(
        'PUBLISH CREDIT ALREADY CHARGED'
      );

    }


    // =========================================================
    // EBAY SETTINGS
    // =========================================================

    publishStage = 'SETTINGS';


    if (
      listing.marketplace_id &&
      sellerSettings.marketplaceId &&
      listing.marketplace_id !==
        sellerSettings.marketplaceId
    ) {
      throw new Error(
        `Saved marketplace ${listing.marketplace_id} does not match the connected eBay account marketplace ${sellerSettings.marketplaceId}. Save the draft destination again before publishing.`
      );
    }


    // =========================================================
    // PER-PRODUCT OVERRIDES (set in the listing editor)
    // =========================================================
    // Policies: when "Use Dynamic Policies" is off, any policy chosen for this
    // product replaces the eBay account default; blank ones keep the default.
    if (!listing.use_dynamic_policies) {
      if (listing.payment_policy_id) sellerSettings.paymentPolicyId = listing.payment_policy_id;
      if (listing.shipping_policy_id) sellerSettings.fulfillmentPolicyId = listing.shipping_policy_id;
      if (listing.return_policy_id) sellerSettings.returnPolicyId = listing.return_policy_id;
    }
    // Item location: a country + postal code saved on the product wins over the account location.
    if (listing.country_location && listing.postal_code) {
      sellerSettings.productLocationMode = 'custom';
      sellerSettings.customCountryCode = listing.country_location;
      sellerSettings.customPostalCode = listing.postal_code;
    }

    // =========================================================
    // CUSTOM LOCATION
    // =========================================================

    if (
      sellerSettings.productLocationMode ===
        'custom' &&
      sellerSettings.customCountryCode &&
      sellerSettings.customPostalCode
    ) {

      debug(
        'CREATING/GETTING CUSTOM EBAY LOCATION'
      );


      sellerSettings.merchantLocationKey =
        await createOrGetCustomLocation(
          refreshToken,
          sellerSettings.customCountryCode,
          sellerSettings.customPostalCode
        );


      debug(
        'CUSTOM EBAY LOCATION READY',
        {
          merchantLocationKey:
            sellerSettings.merchantLocationKey,
        }
      );
    }


    // =========================================================
    // BUILD PRODUCT
    // =========================================================

    publishStage =
      'BUILD_PRODUCT';


    // The saved listing snapshot is the source of truth for publish. The
    // linked import remains the fallback for older drafts created before the
    // snapshot fields existed.
    const product = {
      ...importRecord.product,

      title:
        listing.title ||
        importRecord.product.title,

      description:
        listing.description ||
        importRecord.product.description ||
        '',

      bulletPoints:
        Array.isArray(listing.bullet_points) && listing.bullet_points.length
          ? listing.bullet_points
          : (Array.isArray(importRecord.product.bulletPoints) ? importRecord.product.bulletPoints : []),

      specifications:
        Array.isArray(listing.specifications) && listing.specifications.length
          ? listing.specifications
          : (Array.isArray(importRecord.product.specifications) ? importRecord.product.specifications : []),

      images:
        listing.images_customized
          ? (
              listing.images || []
            )
          : (
              listing.images?.length
                ? listing.images
                : (
                    importRecord.product.images ||
                    []
                  )
            ),

      ebayAspects:
        listing.ebay_aspects && typeof listing.ebay_aspects === 'object' && Object.keys(listing.ebay_aspects).length
          ? listing.ebay_aspects
          : (importRecord.product.ebayAspects || {}),
    };


    debug(
      'PRODUCT READY',
      {
        asin:
          product.asin ||
          null,

        title:
          product.title ||
          null,

        imageCount:
          Array.isArray(product.images)
            ? product.images.length
            : 0,

        sellPrice:
          listing.sell_price,

        quantity:
          listing.quantity,

        categoryId:
          listing.category_id,

        sku:
          listing.sku ||
          null,
      }
    );


    // =========================================================
    // EBAY PUBLISH
    // =========================================================

    publishStage =
      'EBAY_PUBLISH';


    debug(
      'CALLING EBAY PUBLISH'
    );


    // Sanity checks that eBay would otherwise answer with an error after a slow round trip.
    if (!Number.isFinite(Number(listing.sell_price)) || Number(listing.sell_price) <= 0) throw new Error('The sell price must be greater than 0.');
    if (!(Number(listing.quantity) >= 1)) throw new Error('The quantity must be at least 1.');
    if (String(product.title || '').trim().length < 3) throw new Error('The title is too short.');

    // The category must exist on this marketplace and be a final (leaf) category.
    await assertUsableCategory({ categoryId: listing.category_id, marketplaceId: sellerSettings.marketplaceId });

    // Package weight/size (read from the Amazon specs BEFORE they are replaced by eBay aspects below).
    // A CALCULATED-shipping policy cannot price the postage without a weight, and eBay then rejects the publish.
    const packageWeightAndSize = toEbayPackageWeightAndSize(extractPackageInfo(product.specifications));
    if (packageWeightAndSize) {
      debug('PACKAGE', packageWeightAndSize);
    } else if (sellerSettings.fulfillmentPolicyId) {
      const calculated = await fulfillmentPolicyUsesCalculatedShipping(refreshToken, sellerSettings.fulfillmentPolicyId, sellerSettings.marketplaceId);
      if (calculated) {
        throw new Error('Your shipping policy uses calculated shipping, so eBay needs the package weight and none was found for this product. Open the draft → Item Specifications → Custom specifications, add "Package Weight" with a value like "1.5 lb" (or "700 g"), then publish again.');
      }
    }

    // Item specifics: match eBay's allowed values, fill what eBay lets you mark "not applicable", stop early if a required one is missing.
    const prepared = await prepareAspects({ categoryId: listing.category_id, marketplaceId: sellerSettings.marketplaceId, product });
    if (prepared.aspects) {
      product.ebayAspects = prepared.aspects;
      product.specifications = [];
      product.brand = undefined;
      prepared.notes.forEach((n) => debug('ASPECTS: ' + n));
    }

    // eBay needs at least one picture.
    if (!Array.isArray(product.images) || !product.images.some((u) => String(u || '').toLowerCase().startsWith('https://'))) {
      throw new Error('This listing has no usable image. Add at least one image (https) in the editor and publish again.');
    }

    // The offer is always priced in the store's marketplace currency. A draft priced in another
    // currency (e.g. USD from Amazon US, published to a UK store) is converted first, so the
    // number that goes live means what the seller saw.
    let publishPrice = listing.sell_price;
    const storeCurrency = getMarketplaceConfig(sellerSettings.marketplaceId)?.currency;
    // What the price is in: the Amazon site it was read from decides (drafts saved with a wrong default of USD exist),
    // then the currency saved on the draft.
    const draftCurrency = sourceCurrency(importRecord.amazon_url, listing.currency) || '';
    if (storeCurrency && draftCurrency && draftCurrency !== storeCurrency) {
      try {
        const fx = await convertAmount(listing.sell_price, draftCurrency, storeCurrency);
        publishPrice = fx.amount;
        debug('PRICE CONVERTED', { from: draftCurrency, to: storeCurrency, rate: fx.rate, price: publishPrice });
      } catch (fxErr) {
        throw new Error('This draft is priced in ' + draftCurrency + ' but the store sells in ' + storeCurrency + ', and the exchange rate could not be loaded (' + fxErr.message + '). Try again in a minute.');
      }
    }

    const result =
      await publishWithTransientRetry(publishListing, {
        refreshToken,

        product,

        sellPrice:
          publishPrice,

        quantity:
          listing.quantity,

        categoryId:
          listing.category_id,

        sku:
          listing.sku,

        sellerSettings,

        packageWeightAndSize,

        timeoutMs:
          4 * 60 * 1000,
      }, { log: debug });


    // =========================================================
    // EBAY SUCCESS
    // =========================================================

    debug(
      'EBAY PUBLISH SUCCESS',
      {
        offerId:
          result?.offerId ||
          null,

        listingId:
          result?.listingId ||
          null,

        imageCount:
          Array.isArray(
            result?.imageUrls
          )
            ? result.imageUrls.length
            : 0,
      }
    );


    // =========================================================
    // MARK PUBLISHED
    // =========================================================

    publishStage =
      'MARK_PUBLISHED';


    const updated =
      await markPublished(
        userId,
        id,
        {
          offerId:
            result.offerId,

          listingId:
            result.listingId,

          ebayAccountId:
            listing.ebay_account_id,

          publishResponse:
            result,

          ebayImageUrls:
            result.imageUrls ||
            [],
        }
      );


    debug(
      'LISTING MARKED PUBLISHED',
      {
        listingId: id,
      }
    );


    // =========================================================
    // SUCCESS NOTIFICATION
    // =========================================================

    await createSystemNotification(
      userId,
      {
        type:
          'publish_success',

        level:
          'success',

        title:
          'Listing published',

        message:
          `${listing.title || listing.sku} is now live on eBay.`,

        listingId:
          id,

        metadata:
          {
            listingId:
              result.listingId ||
              null,

            offerId:
              result.offerId ||
              null,

            response:
              result,
          },
      }
    ).catch(() => {});


    return updated;


  } catch (err) {

    // =========================================================
    // ERROR DETAILS
    // =========================================================

    const details =
      normalizeError(err);


    console.error(
      '[PUBLISH] FAILED',
      {
        listingId:
          id,

        sku:
          listing.sku ||
          null,

        stage:
          publishStage,

        statusCode:
          details.statusCode,

        code:
          details.code,

        message:
          details.message,

        ebayErrors:
          details.ebayErrors,

        stack:
          err?.stack,
      }
    );


    // =========================================================
    // REFUND CREDIT
    // =========================================================

    if (charged) {
      await refundCredit(
        userId,
        ACTION_COSTS.EBAY_PUBLISH
      ).catch(() => {});
    }


    await markPublishCreditCharged(
      userId,
      id,
      false
    ).catch(() => {});


    // =========================================================
    // MARK ERROR
    // =========================================================

    const updated =
      await markError(
        userId,
        id,
        details.message,
        details
      );


    // =========================================================
    // ERROR NOTIFICATION
    // =========================================================

    await createSystemNotification(
      userId,
      {
        type:
          'publish_failed',

        level:
          'error',

        title:
          'Publish failed',

        message:
          `${listing.title || listing.sku}: ${details.message}`,

        listingId:
          id,

        metadata:
          details,
      }
    ).catch(() => {});


    return updated;
  }
}


// =============================================================
// BACKGROUND PUBLISH QUEUE
// =============================================================

const QUEUE_MIN_AGE_MINUTES = 3;

async function processPublishQueue({ afterEach } = {}) {

  // Only listings that have waited a while and that nobody holds: the ones just claimed are being worked on by the request or the
  // runner that claimed them (see acquirePublishLease). A restart that lost the runner's memory leaves such listings behind.
  const listings =
    await listPublishingListings(50, QUEUE_MIN_AGE_MINUTES);


  for (
    const listing of listings
  ) {

    await processOneQueuedListing(
      listing
    );

    // a long queue keeps its lease while it works (jobs/publishQueue.js)
    if (afterEach) await afterEach();
  }


  return listings.length;
}


// =============================================================
// EXPORTS
// =============================================================

module.exports = {
  processPublishQueue,
  processOneQueuedListing,
  publishWithTransientRetry,
  isTransientEbayError,
};
