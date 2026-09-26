const { requireAsinSku } = require('./skuService');
const { identifierFields } = require('./productIdentifiers');
const { stripInvisible } = require('./textCleanService');
const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');
const { getMarketplaceConfig, getMarketplaceLocale, assertSupportedMarketplace } = require('../config/ebayMarketplaces');
const { normalizeLive, mergeAspects, firstValue } = require('./liveListingSync');
const { convertAmount } = require('./currencyService');

/**
 * Maps an eBay marketplace ID to its expected listing currency. eBay
 * requires the price currency to match the marketplace the offer is
 * created for - sending USD for an EBAY_GB offer, for example, is
 * rejected (or worse, silently mispriced) by eBay.
 */
function getCurrencyForMarketplace(marketplaceId) {
  return getMarketplaceConfig(marketplaceId)?.currency || null;
}

const { retryWithBackoff } = require('./retryService');

/**
 * One eBay error as text. eBay's generic errors ("A system error has occurred", "Invalid value") only say what is wrong in
 * their `parameters` (field name/value) or `longMessage`, so those are included instead of hidden.
 */
function describeEbayError(e) {
  const extra = [];
  if (e.longMessage && e.longMessage !== e.message) extra.push(e.longMessage);
  if (Array.isArray(e.parameters) && e.parameters.length) {
    extra.push(e.parameters.map((p) => `${p.name}: ${String(p.value).slice(0, 80)}`).join(', '));
  }
  const base = e.errorId ? `${e.message} (eBay error ${e.errorId})` : e.message;
  return extra.length ? `${base} [${extra.join(' | ')}]` : base;
}

/**
 * A small helper that sends an authenticated request to eBay (on behalf of
 * a specific user's refresh token) and turns eBay-style error objects into
 * a readable message.
 *
 * GET requests are automatically retried on transient failures (network
 * issues, timeouts, 5xx/429) - safe to retry since they don't change
 * anything on eBay's side. POST/PUT/DELETE are NOT retried here, since
 * retrying a write (e.g. "create this offer") on a transient failure could
 * create a duplicate if the original request actually succeeded server-side
 * but the response was lost - callers that need write-retries should
 * implement their own idempotency check first.
 */
async function ebayRequest(refreshToken, method, path, body, options = {}) {
  const accessToken = await getAccessToken(refreshToken);

  const requestMarketplaceId = options.marketplaceId || body?.marketplaceId || null;
  const requestMarketplace = requestMarketplaceId ? getMarketplaceConfig(requestMarketplaceId) : null;
  if (requestMarketplaceId && !requestMarketplace) {
    throw new Error(`Unsupported eBay marketplace \"${requestMarketplaceId}\".`);
  }
  const requestLocale = requestMarketplace?.locale || 'en-US';

  const makeRequest = () => {
    const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : 20000;

    if (remaining <= 0) {
      const err = new Error(options.timeoutMessage || 'eBay request timed out.');
      err.code = 'EBAY_PUBLISH_TIMEOUT';
      err.statusCode = 504;
      return Promise.reject(err);
    }

    return axios({
      method,
      url: `${EBAY_BASE_URL}${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Language': requestLocale,
        'Accept-Language': requestLocale,
        ...(requestMarketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': requestMarketplaceId } : {}),
      },
      timeout: Math.min(options.maxTimeoutMs || 20000, remaining),
    });
  };

  try {
    const response = method.toUpperCase() === 'GET'
      ? await retryWithBackoff(makeRequest)
      : await makeRequest();

    return response.data;
  } catch (err) {
    const ebayErrors = err.response?.data?.errors;

    const message =
      ebayErrors && ebayErrors.length
        ? ebayErrors.map(describeEbayError).join('; ')
        : err.message || 'The eBay API request failed.';

    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    wrapped.ebayErrors = ebayErrors;

    throw wrapped;
  }
}

/**
 * Finds an existing offer for a SKU and marketplace. eBay only allows one
 * offer for a given seller/SKU/marketplace combination, so publish retries
 * must update and reuse an existing offer instead of blindly creating a new one.
 */
async function findExistingOffer(refreshToken, sku, marketplaceId, options = {}) {
  const query = `?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`;

  const result = await ebayRequest(
    refreshToken,
    'GET',
    `/sell/inventory/v1/offer${query}`,
    undefined,
    { ...options, marketplaceId }
  );

  const offers = Array.isArray(result?.offers) ? result.offers : [];

  return offers[0] || null;
}

/**
 * Updates an existing offer with the current ELMS values. eBay's updateOffer
 * endpoint expects the full editable offer representation, so preserve the
 * existing fields and replace only the listing values we own.
 */
async function updateExistingOffer(refreshToken, offerId, offerBody, options = {}) {
  const current = await ebayRequest(
    refreshToken,
    'GET',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    undefined,
    { ...options, marketplaceId: options.marketplaceId || offerBody?.marketplaceId }
  );

  const {
    offerId: _offerId,
    listing: _listing,
    ...editable
  } = current || {};

  const merged = {
    ...editable,
    ...offerBody,
  };

  await ebayRequest(
    refreshToken,
    'PUT',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    merged,
    options
  );

  return {
    ...merged,
    offerId,
  };
}

async function uploadImagesToEbay(refreshToken, imageUrls, deadlineAt = null, marketplaceId = 'EBAY_US') {
  const urls = [
    ...new Set(
      (Array.isArray(imageUrls) ? imageUrls : [])
        .map((u) => String(u || '').trim())
        .filter((u) => /^https:\/\//i.test(u))
    ),
  ].slice(0, 24);

  if (!urls.length) return [];

  const accessToken = await getAccessToken(refreshToken);
  const mediaMarketplaceId = assertSupportedMarketplace(marketplaceId);
  const mediaLocale = getMarketplaceLocale(mediaMarketplaceId) || 'en-US';

  const uploaded = new Array(urls.length).fill(null);
  const concurrency = 3;

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= urls.length) return;

      const imageUrl = urls[index];

      try {
        const remaining = deadlineAt
          ? deadlineAt - Date.now()
          : 20000;

        if (remaining <= 0) {
          const err = new Error(
            'eBay publish timed out while importing images.'
          );

          err.code = 'EBAY_PUBLISH_TIMEOUT';
          err.statusCode = 504;

          throw err;
        }

        const response = await axios.post(
          `${EBAY_BASE_URL.replace(
            /\/sell\/inventory\/v1$/,
            ''
          )}/commerce/media/v1_beta/image/create_image_from_url`,
          {
            imageUrl,
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Content-Language': mediaLocale,
              'Accept-Language': mediaLocale,
              'X-EBAY-C-MARKETPLACE-ID': mediaMarketplaceId,
            },
            timeout: Math.min(20000, remaining),
          }
        );

        if (response.data?.imageUrl) {
          uploaded[index] = response.data.imageUrl;
        }
      } catch (err) {
        if (err.code === 'EBAY_PUBLISH_TIMEOUT') {
          throw err;
        }

        const ebayErrors = err.response?.data?.errors;

        const detail = ebayErrors?.length
          ? ebayErrors.map((e) => e.message).join('; ')
          : err.message;

        console.warn(
          `eBay image import skipped: ${detail}`
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(concurrency, urls.length),
      },
      worker
    )
  );

  const ordered = uploaded.filter(Boolean);

  if (!ordered.length) {
    const err = new Error(
      'eBay could not import any of the product images. The source image URLs may be blocked or unavailable to eBay.'
    );

    err.statusCode = 422;

    throw err;
  }

  return ordered;
}

/**
 * Everything eBay needs for one listing, checked and built: the inventory item body and the offer body. Throws the same errors a
 * publish always threw for a missing policy / category. Used by publishListing (one listing, one call at a time) and by the bulk
 * publisher (25 listings per call), so both send exactly the same thing.
 */
function buildListingBodies({ product, sellPrice, quantity, categoryId, sku, sellerSettings, packageWeightAndSize = null }) {
  const {
    merchantLocationKey,
    paymentPolicyId,
    fulfillmentPolicyId,
    returnPolicyId,
    marketplaceId = 'EBAY_US',
  } = sellerSettings || {};

  const normalizedMarketplaceId = assertSupportedMarketplace(marketplaceId);
  const marketplaceConfig = getMarketplaceConfig(normalizedMarketplaceId);

  if (!merchantLocationKey || !paymentPolicyId || !fulfillmentPolicyId || !returnPolicyId) {
    throw new Error('This eBay account is missing its business policy setup (merchant location, payment/fulfillment/return policies).');
  }

  if (!categoryId) {
    throw new Error('An eBay categoryId is required.');
  }

  const finalSku = requireAsinSku(sku || product.asin, 'Amazon product');

  // Pass the image URLs straight to eBay in the inventory item, the way the known-working build did. eBay fetches these URLs itself when
  // the listing publishes. We intentionally do NOT pre-upload via the Media API (create_image_from_url): that extra call is unreliable
  // (especially on Sandbox, where it's a v1_beta endpoint) and was failing every publish with "could not import any of the product
  // images". Our images are already materialized to our own public, high-res URLs at import time, so eBay can fetch them directly.
  const imageUrls = [
    ...new Set(
      (Array.isArray(product.images) ? product.images : [])
        .map((u) => String(u || '').trim())
        .filter((u) => /^https:\/\//i.test(u))
    ),
  ].slice(0, 24);

  const inventoryItemBody = {
    availability: {
      shipToLocationAvailability: {
        quantity: quantity || 1,
      },
    },

    condition: 'NEW',

    // Needed by CALCULATED-shipping policies (eBay works the buyer's postage out from it).
    ...(packageWeightAndSize ? { packageWeightAndSize } : {}),

    product: {
      title: (product.title || '').slice(0, 80),

      description: product.description || product.bulletPoints?.join('\n') || product.title,

      imageUrls,

      aspects: buildAspects(product),

      // Only after eBay said a barcode is missing: "Does not apply" (see services/productIdentifiers.js).
      ...identifierFields(product),
    },
  };

  const offerBody = {
    sku: finalSku,

    marketplaceId: normalizedMarketplaceId,

    format: 'FIXED_PRICE',

    listingDescription: product.description || product.title,

    availableQuantity: quantity || 1,

    categoryId,

    merchantLocationKey,

    pricingSummary: {
      price: {
        value: Number(sellPrice).toFixed(2),
        currency: marketplaceConfig.currency,
      },
    },

    listingPolicies: {
      paymentPolicyId,
      fulfillmentPolicyId,
      returnPolicyId,
    },
  };

  return { finalSku, marketplaceId: normalizedMarketplaceId, imageUrls, inventoryItemBody, offerBody };
}

/**
 * Publishes an Amazon product as a live listing on eBay, on behalf of a
 * specific ELMS user (using their connected eBay account).
 * 3 steps: inventory item -> offer -> publish.
 *
 * @param {object} params
 * @param {string} params.refreshToken - the user's eBay refresh token
 * @param {object} params.product - normalized Rainforest product object
 * @param {number} params.sellPrice - final eBay sell price (from the Edit Price modal)
 * @param {number} params.quantity - how many units to list
 * @param {string} params.categoryId - eBay category ID
 * @param {string} params.sku - unique SKU (defaults to one built from the ASIN)
 * @param {object} params.sellerSettings - { merchantLocationKey, paymentPolicyId, fulfillmentPolicyId, returnPolicyId, marketplaceId }
 */
async function publishListing({
  refreshToken,
  product,
  sellPrice,
  quantity,
  categoryId,
  sku,
  sellerSettings,
  packageWeightAndSize = null,
  timeoutMs = 4 * 60 * 1000,
}) {
  const deadlineAt = Date.now() + timeoutMs;

  const built = buildListingBodies({ product, sellPrice, quantity, categoryId, sku, sellerSettings, packageWeightAndSize });
  const { finalSku, marketplaceId: normalizedMarketplaceId, inventoryItemBody, offerBody } = built;
  const directImageUrls = built.imageUrls;

  // ---------- Step 1: Inventory Item ----------
  // (The image URLs go straight to eBay in the inventory item - see buildListingBodies.)

  // ---------- IMAGE DEBUG ----------
  // Temporary diagnostics: confirms exactly which URLs ELMS sends to eBay.
  console.log('========== EBAY IMAGE DEBUG ==========');
  console.log('Product ASIN:', product.asin || 'N/A');
  console.log('Product image count:', Array.isArray(product.images) ? product.images.length : 0);
  console.log('Filtered HTTPS image count:', directImageUrls.length);
  console.log('Image URLs sent to eBay:');
  console.log(JSON.stringify(directImageUrls, null, 2));
  console.log('======================================');

  await ebayRequest(
    refreshToken,
    'PUT',
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(finalSku)}`,
    inventoryItemBody,
    {
      deadlineAt,
      marketplaceId: normalizedMarketplaceId,
      timeoutMessage: 'eBay publish timed out while creating the inventory item.',
    }
  );

  console.log('eBay inventory item accepted for SKU:', finalSku);
  console.log('eBay inventory item image count:', inventoryItemBody.product.imageUrls.length);

  // ---------- Step 2: Create Offer ----------
  let existingOffer = null;

  try {
    existingOffer = await findExistingOffer(
      refreshToken,
      finalSku,
      normalizedMarketplaceId,
      {
        deadlineAt,
        marketplaceId: normalizedMarketplaceId,
        timeoutMessage:
          'eBay publish timed out while checking the existing offer.',
      }
    );
  } catch (err) {
    // If the lookup itself fails for a transient/unsupported reason, preserve
    // the normal create path so an otherwise healthy publish can proceed.
    console.warn(
      'existing-offer lookup failed:',
      err.message
    );
  }

  let offerId;
  let offerAlreadyPublished = false;

  if (existingOffer?.offerId) {
    offerId = existingOffer.offerId;

    offerAlreadyPublished =
      !!existingOffer.listing;

    if (!offerAlreadyPublished) {
      await updateExistingOffer(
        refreshToken,
        offerId,
        offerBody,
        {
          deadlineAt,
          marketplaceId: normalizedMarketplaceId,
          timeoutMessage:
            'eBay publish timed out while updating the offer.',
        }
      );
    }
  } else {
    try {
      const offerResult =
        await ebayRequest(
          refreshToken,
          'POST',
          '/sell/inventory/v1/offer',
          offerBody,
          {
            deadlineAt,
            timeoutMessage:
              'eBay publish timed out while creating the offer.',
          }
        );

      offerId =
        offerResult.offerId;
    } catch (err) {
      // eBay can return "Offer entity already exists" when a prior request
      // succeeded but the response was lost. Re-query once and reuse it.
      const alreadyExists =
        /offer entity already exists|offer already exists/i.test(
          err.message || ''
        );

      if (!alreadyExists) {
        throw err;
      }

      const recovered =
        await findExistingOffer(
          refreshToken,
          finalSku,
          normalizedMarketplaceId,
          {
            deadlineAt,
            marketplaceId: normalizedMarketplaceId,
            timeoutMessage:
              'eBay publish timed out while recovering the offer.',
          }
        );

      if (!recovered?.offerId) {
        throw err;
      }

      offerId =
        recovered.offerId;

      offerAlreadyPublished =
        !!recovered.listing;

      if (!offerAlreadyPublished) {
        await updateExistingOffer(
          refreshToken,
          offerId,
          offerBody,
          {
            deadlineAt,
            marketplaceId: normalizedMarketplaceId,
            timeoutMessage:
              'eBay publish timed out while updating the offer.',
          }
        );
      }
    }
  }

  if (!offerId) {
    throw new Error(
      'eBay did not return an offerId, so the offer could not be created.'
    );
  }

  // ---------- Step 3: Publish Offer ----------
  if (offerAlreadyPublished) {
    return {
      sku: finalSku,

      offerId,

      listingId:
        existingOffer?.listing?.listingId ||
        existingOffer?.listingId ||
        null,

      imageUrls:
        inventoryItemBody.product.imageUrls ||
        [],
    };
  }

  const publishResult =
    await ebayRequest(
      refreshToken,
      'POST',
      `/sell/inventory/v1/offer/${encodeURIComponent(
        offerId
      )}/publish`,
      undefined,
      {
        deadlineAt,
        marketplaceId: normalizedMarketplaceId,
        timeoutMessage:
          'eBay publish timed out while publishing the offer.',
      }
    );

  return {
    sku: finalSku,

    offerId,

    listingId:
      publishResult.listingId ||
      null,

    imageUrls:
      inventoryItemBody.product.imageUrls ||
      [],
  };
}

/**
 * Ends (withdraws) a live eBay offer, taking the listing down.
 * Used by the stock monitor when the source Amazon product goes out of stock.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} offerId - the eBay offerId returned when the listing was published
 */
async function publishExistingOffer(refreshToken, offerId) {
  if (!offerId) throw new Error('An offerId is required to publish an existing eBay offer.');
  return ebayRequest(
    refreshToken,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`
  );
}

async function deleteOffer(refreshToken, offerId) {
  if (!offerId) throw new Error('An offerId is required to delete an eBay offer.');
  return ebayRequest(
    refreshToken,
    'DELETE',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );
}

async function withdrawListing(
  refreshToken,
  offerId
) {
  if (!offerId) {
    throw new Error(
      'An offerId is required to withdraw a listing.'
    );
  }

  return ebayRequest(
    refreshToken,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(
      offerId
    )}/withdraw`
  );
}

/**
 * Updates the price of an already-published eBay offer, used by the price
 * monitor when the source Amazon price changes. eBay's Inventory API has
 * no "just change the price" endpoint - updateOffer (PUT) always expects
 * the full offer body back, so this reads the current offer first, swaps
 * in the new price (keeping the offer's own currency), and PUTs the whole
 * thing back. `offerId` and `listing` come back from the GET but are
 * read-only / rejected on the PUT, so they're stripped before sending.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} offerId - the eBay offerId returned when the listing was published
 * @param {number} newPrice - the new sell price (in the offer's own currency)
 */

/**
 * Reads what eBay really holds for a live listing (the offer and its inventory item) as one plain object - see
 * liveListingSync.normalizeLive. This is the truth the ELMS editor should show and the answer to "did eBay take my change".
 */
async function fetchLiveListing(refreshToken, { offerId, sku, deadlineAt = null }) {
  if (!offerId || !sku) throw new Error('An eBay offer ID and SKU are required to read a live listing.');
  const [offer, item] = await Promise.all([
    ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, undefined, { deadlineAt, timeoutMessage: 'eBay timed out while loading the offer.' }),
    ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, { deadlineAt, timeoutMessage: 'eBay timed out while loading the inventory item.' }),
  ]);
  return normalizeLive(offer, item);
}

/**
 * Revises an active Inventory-API listing. The Inventory API requires full replacement payloads for
 * inventory items/offers, so the current eBay objects are read first and only the fields that were sent are changed:
 *  - item specifics are MERGED with the ones eBay already holds (the editor only shows the category's own, and sending
 *    just those used to wipe every other one); `clearAspects` names are taken off;
 *  - the description goes on the offer as well as the inventory item (the offer's listingDescription wins on eBay, so a
 *    description that was only put on the inventory item never showed);
 *  - Brand / MPN stay in step with the item specifics when the item also carries them as product fields;
 *  - `policies` and `merchantLocationKey` change the offer's business policies / item location.
 * Afterwards eBay is read again (`live`), so the caller can tell what eBay actually kept.
 */
async function reviseActiveListing(
  refreshToken,
  {
    offerId,
    sku,
    title,
    description,
    images,
    aspects,
    clearAspects,
    sellPrice,
    priceCurrency,
    quantity,
    categoryId,
    policies,
    merchantLocationKey,
    deadlineAt = null,
  }
) {
  if (!offerId) {
    throw new Error('An eBay offer ID is required to revise a live listing.');
  }
  if (!sku) {
    throw new Error('An eBay SKU is required to revise a live listing.');
  }
  if (!Number.isFinite(Number(sellPrice)) || Number(sellPrice) <= 0) {
    throw new Error('A valid selling price is required.');
  }
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error('A valid quantity is required.');
  }

  const currentOffer = await ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, undefined, {
    deadlineAt,
    timeoutMessage: 'eBay timed out while loading the current offer.',
  });

  const { offerId: _offerId, listing: _listing, ...offerEditable } = currentOffer || {};

  // The offer is always priced in its own marketplace currency: a price given in another one (priceCurrency) is converted first.
  let pushPrice = Number(sellPrice);
  const offerCurrency = offerEditable.pricingSummary?.price?.currency;
  if (priceCurrency && offerCurrency && String(priceCurrency).toUpperCase() !== String(offerCurrency).toUpperCase()) {
    pushPrice = (await convertAmount(pushPrice, priceCurrency, offerCurrency)).amount;
  }

  const currentInventory = await ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, {
    deadlineAt,
    timeoutMessage: 'eBay timed out while loading the current inventory item.',
  });

  const inventoryProduct = currentInventory?.product || {};
  const newDescription = typeof description === 'string' && description.trim() ? description : null;

  const offerUpdate = {
    ...offerEditable,
    sku,
    availableQuantity: Number(quantity),
    categoryId: categoryId || offerEditable.categoryId,
    pricingSummary: {
      ...offerEditable.pricingSummary,
      price: {
        ...(offerEditable.pricingSummary?.price || {}),
        value: pushPrice.toFixed(2),
      },
    },
    ...(newDescription ? { listingDescription: newDescription } : {}),
  };
  const wantedPolicies = Object.fromEntries(Object.entries(policies || {}).filter(([, v]) => v));
  if (Object.keys(wantedPolicies).length) {
    offerUpdate.listingPolicies = { ...(offerEditable.listingPolicies || {}), ...wantedPolicies };
  }
  if (merchantLocationKey) offerUpdate.merchantLocationKey = merchantLocationKey;

  const cleanImages = Array.from(
    new Set(
      (Array.isArray(images) ? images : inventoryProduct.imageUrls || [])
        .map((u) => String(u || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
    )
  ).slice(0, 24);

  let mergedAspects = null;
  if ((aspects && typeof aspects === 'object') || (Array.isArray(clearAspects) && clearAspects.length)) {
    mergedAspects = mergeAspects(inventoryProduct.aspects || {}, buildAspects({ ebayAspects: aspects || {} }), clearAspects);
  }

  const product = {
    ...inventoryProduct,
    title: String(title || inventoryProduct.title || '').slice(0, 80),
    description: newDescription || inventoryProduct.description || offerEditable.listingDescription || title || '',
    ...(cleanImages.length ? { imageUrls: cleanImages } : {}),
    ...(mergedAspects ? { aspects: mergedAspects } : {}),
  };
  // Brand / MPN that the item also holds as product fields must not keep the old value next to the new item specific.
  if (mergedAspects) {
    for (const [field, aspect] of [['brand', 'Brand'], ['mpn', 'MPN']]) {
      if (!Object.prototype.hasOwnProperty.call(inventoryProduct, field)) continue;
      const value = firstValue(mergedAspects, aspect);
      if (value) product[field] = value;
      else if ((clearAspects || []).some((n) => String(n).trim().toLowerCase() === aspect.toLowerCase())) delete product[field];
    }
  }

  const inventoryUpdate = {
    availability: {
      ...(currentInventory?.availability || {}),
      shipToLocationAvailability: {
        ...(currentInventory?.availability?.shipToLocationAvailability || {}),
        quantity: Number(quantity),
      },
    },
    condition: currentInventory?.condition || 'NEW',
    ...(currentInventory?.conditionDescription ? { conditionDescription: currentInventory.conditionDescription } : {}),
    ...(currentInventory?.packageWeightAndSize ? { packageWeightAndSize: currentInventory.packageWeightAndSize } : {}),
    product,
  };

  await ebayRequest(refreshToken, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, inventoryUpdate, {
    deadlineAt,
    timeoutMessage: 'eBay timed out while updating the inventory item.',
  });

  await ebayRequest(refreshToken, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, offerUpdate, {
    marketplaceId: currentOffer?.marketplaceId || null,
    deadlineAt,
    timeoutMessage: 'eBay timed out while updating the live offer.',
  });

  // Read it back: what eBay holds now is the truth (a catalog-matched item, for example, keeps its own Brand).
  let live = null;
  let liveError = null;
  try {
    live = await fetchLiveListing(refreshToken, { offerId, sku, deadlineAt });
  } catch (err) {
    liveError = err.message;
  }

  return {
    offerId,
    sku,
    sellPrice: Number(sellPrice),
    pushedPrice: pushPrice,
    quantity: Number(quantity),
    categoryId: offerUpdate.categoryId || null,
    sentAspects: mergedAspects,
    imageCount: cleanImages.length,
    live,
    liveError,
  };
}

async function updateOfferPrice(
  refreshToken,
  offerId,
  newPrice
) {
  if (!offerId) {
    throw new Error(
      'An offerId is required to update a listing price.'
    );
  }

  if (
    !Number.isFinite(Number(newPrice)) ||
    Number(newPrice) <= 0
  ) {
    throw new Error(
      'A valid new price is required to update a listing price.'
    );
  }

  const offer =
    await ebayRequest(
      refreshToken,
      'GET',
      `/sell/inventory/v1/offer/${encodeURIComponent(
        offerId
      )}`
    );

  const marketplaceId = offer.marketplaceId || null;
  const currency =
    offer.pricingSummary?.price?.currency ||
    getCurrencyForMarketplace(marketplaceId) ||
    'USD';

  const {
    offerId: _offerId,
    listing: _listing,
    ...updatable
  } = offer;

  const updatedOffer = {
    ...updatable,

    pricingSummary: {
      ...offer.pricingSummary,

      price: {
        value:
          Number(newPrice).toFixed(2),

        currency,
      },
    },
  };

  await ebayRequest(
    refreshToken,
    'PUT',
    `/sell/inventory/v1/offer/${encodeURIComponent(
      offerId
    )}`,
    updatedOffer,
    { marketplaceId }
  );

  return {
    offerId,

    newPrice:
      updatedOffer.pricingSummary.price.value,

    currency,
  };
}


/**
 * Phase 3: safely synchronizes the available quantity on an active offer.
 *
 * eBay's Inventory API requires the offer update to preserve the existing
 * offer fields, so we first retrieve the current offer and then replace only
 * pricingSummary/availableQuantity. This avoids accidentally dropping the
 * seller's category, policies, marketplace, or other offer settings.
 *
 * ELMS intentionally accepts only a positive integer quantity here. A source
 * that is out of stock is handled by withdrawListing(), rather than leaving
 * an active eBay offer with zero quantity.
 */
async function updateOfferQuantity(refreshToken, offerId, newQuantity) {
  if (!offerId) {
    throw new Error('An offerId is required to update a listing quantity.');
  }

  const quantity = Number(newQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('A valid positive integer quantity is required to update a listing quantity.');
  }

  const offer = await ebayRequest(
    refreshToken,
    'GET',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );

  const {
    offerId: _offerId,
    listing: _listing,
    ...updatable
  } = offer || {};

  const updatedOffer = {
    ...updatable,
    availableQuantity: quantity,
  };

  await ebayRequest(
    refreshToken,
    'PUT',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    updatedOffer,
    { marketplaceId: offer?.marketplaceId || null }
  );

  return { offerId, quantity };
}

const policyCostTypeCache = new Map();
const POLICY_CACHE_MS = 10 * 60 * 1000;

/**
 * Does this fulfillment policy use CALCULATED shipping (weight/size based)? Such a policy makes eBay
 * reject a listing that has no package weight. Returns null when it cannot be determined (the caller
 * then simply doesn't block anything).
 */
async function fulfillmentPolicyUsesCalculatedShipping(refreshToken, fulfillmentPolicyId, marketplaceId) {
  const key = `${marketplaceId}:${fulfillmentPolicyId}`;
  const hit = policyCostTypeCache.get(key);
  if (hit && Date.now() - hit.at < POLICY_CACHE_MS) return hit.value;
  try {
    const policy = await ebayRequest(
      refreshToken, 'GET',
      `/sell/account/v1/fulfillment_policy/${encodeURIComponent(fulfillmentPolicyId)}`,
      undefined, { marketplaceId }
    );
    const options = Array.isArray(policy?.shippingOptions) ? policy.shippingOptions : [];
    const value = options.some((o) => String(o.costType).toUpperCase() === 'CALCULATED');
    policyCostTypeCache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.warn('fulfillment policy lookup failed:', err.message);
    return null;
  }
}

/**
 * Fetches a user's eBay Business Policies (payment/return/fulfillment) and
 * Inventory Locations, so the Settings page can offer them as dropdowns
 * instead of requiring the user to manually copy IDs from Seller Hub.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} marketplaceId - e.g. "EBAY_US" (policies are marketplace-specific)
 */
async function fetchBusinessPolicies(
  refreshToken,
  marketplaceId = 'EBAY_US'
) {
  const normalizedMarketplaceId = assertSupportedMarketplace(marketplaceId);
  const query =
    `?marketplace_id=${encodeURIComponent(
      normalizedMarketplaceId
    )}`;

  // Run all four lookups in parallel. If a seller hasn't opted into Business
  // Policies yet, eBay returns an error for the policy calls specifically -
  // we treat that as "no policies configured" rather than a hard failure,
  // since the user can still set things up and try again.

  const [
    paymentResult,
    returnResult,
    fulfillmentResult,
    locationResult,
  ] = await Promise.allSettled([
    ebayRequest(
      refreshToken,
      'GET',
      `/sell/account/v1/payment_policy${query}`,
      undefined,
      { marketplaceId: normalizedMarketplaceId }
    ),

    ebayRequest(
      refreshToken,
      'GET',
      `/sell/account/v1/return_policy${query}`,
      undefined,
      { marketplaceId: normalizedMarketplaceId }
    ),

    ebayRequest(
      refreshToken,
      'GET',
      `/sell/account/v1/fulfillment_policy${query}`,
      undefined,
      { marketplaceId: normalizedMarketplaceId }
    ),

    ebayRequest(
      refreshToken,
      'GET',
      '/sell/inventory/v1/location'
    ),
  ]);

  const extractList = (
    result,
    key
  ) =>
    result.status === 'fulfilled' &&
    Array.isArray(result.value?.[key])
      ? result.value[key]
      : [];

  const paymentPolicies =
    extractList(
      paymentResult,
      'paymentPolicies'
    ).map((p) => ({
      id:
        p.paymentPolicyId,
      name:
        p.name,
    }));

  const returnPolicies =
    extractList(
      returnResult,
      'returnPolicies'
    ).map((p) => ({
      id:
        p.returnPolicyId,
      name:
        p.name,
    }));

  const fulfillmentPolicies =
    extractList(
      fulfillmentResult,
      'fulfillmentPolicies'
    ).map((p) => ({
      id:
        p.fulfillmentPolicyId,
      name:
        p.name,
    }));

  const locations =
    extractList(
      locationResult,
      'locations'
    ).map((l) => ({
      key:
        l.merchantLocationKey,

      name:
        l.name ||
        l.merchantLocationKey,
    }));

  return {
    paymentPolicies,
    returnPolicies,
    fulfillmentPolicies,
    locations,
  };
}

/**
 * Creates (or reuses, if it already exists) an eBay Inventory Location
 * built from a plain country + postal code, for users who chose "Custom"
 * product location instead of one of their real merchant locations.
 *
 * eBay's modern Inventory API requires every offer to reference a real
 * merchantLocationKey - there's no way to attach a bare postal code
 * directly to a listing the way the older, deprecated Trading API allowed.
 * So we create a lightweight inventory location here and reuse its key.
 *
 * @param {string} refreshToken
 * @param {string} countryCode - ISO 2-letter country code, e.g. "US", "GB"
 * @param {string} postalCode
 */
async function createOrGetCustomLocation(
  refreshToken,
  countryCode,
  postalCode
) {
  const { resolveLocation } = require('./postalGeneratorService');
  const country = String(countryCode || '').toUpperCase();
  const details = await resolveLocation(country, postalCode);
  if (!details.complete) {
    const err = new Error(`The saved postal code "${postalCode}" is incomplete for ${country}. Use the full code (for the UK e.g. "SW1A 1AA") or press Generate in Settings to create a valid one.`);
    err.statusCode = 400;
    throw err;
  }
  const fullCode = details.postalCode;

  // Deterministic key based on the country + full postal code, so calling this
  // again reuses the same location. The "v2" prefix keeps clear of older
  // locations that were saved with an incomplete address.
  const locationKey =
    `elms-v2-${country.toLowerCase()}-${fullCode.replace(/[^a-z0-9]/gi, '')}`.slice(0, 50);

  const address = { country, postalCode: fullCode };
  if (details.city) address.city = details.city;
  if (details.state) address.stateOrProvince = details.state;

  try {
    await ebayRequest(
      refreshToken,
      'POST',
      `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
      {
        location: { address },
        name: `ELMS location (${fullCode}, ${country})`,
        merchantLocationStatus: 'ENABLED',
        locationTypes: ['WAREHOUSE'],
      }
    );
  } catch (err) {
    // eBay answers 409 / "already exists" when this key was created before -
    // that is fine, the existing location is reused. Anything else surfaces.
    const alreadyExists =
      err.statusCode === 409 ||
      /already exists/i.test(err.message || '');
    if (!alreadyExists) throw err;
  }

  return locationKey;
}

/**
 * Builds eBay "item specifics" (aspects) from the product's brand/specifications.
 * eBay expects a format like { "Brand": ["Bose"], "Color": ["Black"] }.
 */
function buildAspects(product) {
  const aspects = {};
  const seenNames = new Set();
  const MAX_EBAY_ITEM_SPECIFICS = 45;

  // eBay allows a maximum of 45 item-specific names on an Inventory API
  // listing. Keep the category-aware values first because these are the
  // values the ELMS UI collected against eBay's taxonomy for the selected
  // category. Extra Amazon specifications are only used while there is room.
  // Amazon pastes invisible direction marks (U+200E ...) into names and values, and eBay rejects < and >.
  const tidy = (v) => stripInvisible(v).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  // Amazon page facts that mean nothing as an eBay item specific.
  const USELESS_NAMES = new Set(['asin', 'best sellers rank', 'customer reviews', 'date first available', 'is discontinued by manufacturer']);

  const addAspect = (name, value) => {
    const cleanName = tidy(name);
    // eBay item specific names are at most 65 characters.
    if (!cleanName || cleanName.length > 65 || aspects[cleanName]) return false;

    const normalizedName = cleanName.toLowerCase();
    if (seenNames.has(normalizedName) || USELESS_NAMES.has(normalizedName)) return false;
    if (Object.keys(aspects).length >= MAX_EBAY_ITEM_SPECIFICS) return false;

    const values = Array.isArray(value) ? value : [value];
    const cleanValues = values
      .map((v) => tidy(v).slice(0, 65).trim())
      .filter(Boolean)
      .slice(0, 30);

    if (!cleanValues.length) return false;

    aspects[cleanName] = cleanValues;
    seenNames.add(normalizedName);
    return true;
  };

  if (product.ebayAspects && typeof product.ebayAspects === 'object') {
    for (const [name, value] of Object.entries(product.ebayAspects)) {
      if (!addAspect(name, value)) {
        if (Object.keys(aspects).length >= MAX_EBAY_ITEM_SPECIFICS) break;
      }
    }
  }

  if (product.brand && Object.keys(aspects).length < MAX_EBAY_ITEM_SPECIFICS) {
    addAspect('Brand', [String(product.brand).trim().slice(0, 65)]);
  }

  for (const spec of product.specifications || []) {
    if (Object.keys(aspects).length >= MAX_EBAY_ITEM_SPECIFICS) break;
    if (spec.name && spec.value) addAspect(spec.name, [spec.value]);
  }

  return aspects;
}

module.exports = {
  publishListing,
  buildListingBodies,
  describeEbayError,
  ebayRequest,
  buildAspects,
  publishExistingOffer,
  deleteOffer,
  withdrawListing,
  updateOfferPrice,
  updateOfferQuantity,
  reviseActiveListing,
  fetchLiveListing,
  fetchBusinessPolicies,
  createOrGetCustomLocation,
  fulfillmentPolicyUsesCalculatedShipping,
};
