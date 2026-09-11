const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

/**
 * Maps an eBay marketplace ID to its expected listing currency. eBay
 * requires the price currency to match the marketplace the offer is
 * created for - sending USD for an EBAY_GB offer, for example, is
 * rejected (or worse, silently mispriced) by eBay.
 */
const MARKETPLACE_TO_CURRENCY = {
  EBAY_US: 'USD',
  EBAY_GB: 'GBP',
  EBAY_CA: 'CAD',
  EBAY_AU: 'AUD',
  EBAY_DE: 'EUR',
  EBAY_FR: 'EUR',
  EBAY_IT: 'EUR',
  EBAY_ES: 'EUR',
  EBAY_NL: 'EUR',
  EBAY_AT: 'EUR',
  EBAY_BE: 'EUR',
  EBAY_IE: 'EUR',
  EBAY_CH: 'CHF',
  EBAY_PL: 'PLN',
  EBAY_HK: 'HKD',
  EBAY_SG: 'SGD',
  EBAY_MY: 'MYR',
  EBAY_PH: 'PHP',
};

function getCurrencyForMarketplace(marketplaceId) {
  return MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
}

const { retryWithBackoff } = require('./retryService');

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
async function ebayRequest(refreshToken, method, path, body) {
  const accessToken = await getAccessToken(refreshToken);

  const makeRequest = () =>
    axios({
      method,
      url: `${EBAY_BASE_URL}${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
        'Accept-Language': 'en-US',
      },
      timeout: 20000,
    });

  try {
    const response = method.toUpperCase() === 'GET'
      ? await retryWithBackoff(makeRequest)
      : await makeRequest();
    return response.data;
  } catch (err) {
    const ebayErrors = err.response?.data?.errors;
    const message =
      ebayErrors && ebayErrors.length
        ? ebayErrors.map((e) => e.message).join('; ')
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
async function findExistingOffer(refreshToken, sku, marketplaceId) {
  const query = `?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`;
  const result = await ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/offer${query}`);
  const offers = Array.isArray(result?.offers) ? result.offers : [];
  return offers[0] || null;
}

/**
 * Updates an existing offer with the current ELMS values. eBay's updateOffer
 * endpoint expects the full editable offer representation, so preserve the
 * existing fields and replace only the listing values we own.
 */
async function updateExistingOffer(refreshToken, offerId, offerBody) {
  const current = await ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const { offerId: _offerId, listing: _listing, ...editable } = current || {};
  const merged = { ...editable, ...offerBody };
  await ebayRequest(refreshToken, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, merged);
  return { ...merged, offerId };
}


async function uploadImagesToEbay(refreshToken, imageUrls) {
  const urls = [...new Set((Array.isArray(imageUrls) ? imageUrls : [])
    .map((u) => String(u || '').trim()).filter((u) => /^https:\/\//i.test(u)))].slice(0, 24);
  if (!urls.length) return [];

  const accessToken = await getAccessToken(refreshToken);
  const uploaded = [];
  for (const imageUrl of urls) {
    try {
      const response = await axios.post(
        `${EBAY_BASE_URL.replace(/\/sell\/inventory\/v1$/, '')}/commerce/media/v1_beta/image/create_image_from_url`,
        { imageUrl },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
            'Accept-Language': 'en-US',
          },
          timeout: 30000,
        }
      );
      if (response.data?.imageUrl) uploaded.push(response.data.imageUrl);
    } catch (err) {
      const ebayErrors = err.response?.data?.errors;
      const detail = ebayErrors?.length ? ebayErrors.map((e) => e.message).join('; ') : err.message;
      console.warn(`eBay image import skipped: ${detail}`);
      continue;
    }
  }
  if (!uploaded.length) {
    const err = new Error('eBay could not import any of the product images. The source image URLs may be blocked or unavailable to eBay.');
    err.statusCode = 422;
    throw err;
  }
  return uploaded;
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
async function publishListing({ refreshToken, product, sellPrice, quantity, categoryId, sku, sellerSettings }) {
  const {
    merchantLocationKey,
    paymentPolicyId,
    fulfillmentPolicyId,
    returnPolicyId,
    marketplaceId = 'EBAY_US',
  } = sellerSettings || {};

  if (!merchantLocationKey || !paymentPolicyId || !fulfillmentPolicyId || !returnPolicyId) {
    throw new Error(
      'This eBay account is missing its business policy setup (merchant location, payment/fulfillment/return policies).'
    );
  }

  if (!categoryId) {
    throw new Error('An eBay categoryId is required.');
  }

  const finalSku = sku || `AMZ-${product.asin || Date.now()}`;

  // ---------- Step 1: Inventory Item ----------
  const inventoryItemBody = {
    availability: {
      shipToLocationAvailability: {
        quantity: quantity || 1,
      },
    },
    condition: 'NEW',
    product: {
      title: (product.title || '').slice(0, 80), // eBay title limit
      description: product.description || product.bulletPoints?.join('\n') || product.title,
      imageUrls: await uploadImagesToEbay(refreshToken, product.images || []),
      aspects: buildAspects(product),
    },
  };

  await ebayRequest(
    refreshToken,
    'PUT',
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(finalSku)}`,
    inventoryItemBody
  );

  // ---------- Step 2: Create Offer ----------
  const offerBody = {
    sku: finalSku,
    marketplaceId,
    format: 'FIXED_PRICE',
    listingDescription: product.description || product.title,
    availableQuantity: quantity || 1,
    categoryId,
    merchantLocationKey,
    pricingSummary: {
      price: {
        value: Number(sellPrice).toFixed(2),
        currency: getCurrencyForMarketplace(marketplaceId),
      },
    },
    listingPolicies: {
      paymentPolicyId,
      fulfillmentPolicyId,
      returnPolicyId,
    },
  };

  let existingOffer = null;
  try {
    existingOffer = await findExistingOffer(refreshToken, finalSku, marketplaceId);
  } catch (err) {
    // If the lookup itself fails for a transient/unsupported reason, preserve
    // the normal create path so an otherwise healthy publish can proceed.
    console.warn('existing-offer lookup failed:', err.message);
  }

  let offerId;
  let offerAlreadyPublished = false;

  if (existingOffer?.offerId) {
    offerId = existingOffer.offerId;
    offerAlreadyPublished = !!existingOffer.listing;
    if (!offerAlreadyPublished) {
      await updateExistingOffer(refreshToken, offerId, offerBody);
    }
  } else {
    try {
      const offerResult = await ebayRequest(refreshToken, 'POST', '/sell/inventory/v1/offer', offerBody);
      offerId = offerResult.offerId;
    } catch (err) {
      // eBay can return "Offer entity already exists" when a prior request
      // succeeded but the response was lost. Re-query once and reuse it.
      const alreadyExists = /offer entity already exists|offer already exists/i.test(err.message || '');
      if (!alreadyExists) throw err;
      const recovered = await findExistingOffer(refreshToken, finalSku, marketplaceId);
      if (!recovered?.offerId) throw err;
      offerId = recovered.offerId;
      offerAlreadyPublished = !!recovered.listing;
      if (!offerAlreadyPublished) await updateExistingOffer(refreshToken, offerId, offerBody);
    }
  }

  if (!offerId) {
    throw new Error('eBay did not return an offerId, so the offer could not be created.');
  }

  // ---------- Step 3: Publish Offer ----------
  if (offerAlreadyPublished) {
    return { sku: finalSku, offerId, listingId: existingOffer?.listing?.listingId || existingOffer?.listingId || null, imageUrls: inventoryItemBody.product.imageUrls || [] };
  }

  const publishResult = await ebayRequest(
    refreshToken,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`
  );

  return {
    sku: finalSku,
    offerId,
    listingId: publishResult.listingId || null,
    imageUrls: inventoryItemBody.product.imageUrls || [],
  };
}

/**
 * Ends (withdraws) a live eBay offer, taking the listing down.
 * Used by the stock monitor when the source Amazon product goes out of stock.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} offerId - the eBay offerId returned when the listing was published
 */
async function withdrawListing(refreshToken, offerId) {
  if (!offerId) {
    throw new Error('An offerId is required to withdraw a listing.');
  }

  return ebayRequest(refreshToken, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
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
async function updateOfferPrice(refreshToken, offerId, newPrice) {
  if (!offerId) {
    throw new Error('An offerId is required to update a listing price.');
  }
  if (!Number.isFinite(Number(newPrice)) || Number(newPrice) <= 0) {
    throw new Error('A valid new price is required to update a listing price.');
  }

  const offer = await ebayRequest(refreshToken, 'GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const currency = offer.pricingSummary?.price?.currency || 'USD';

  const { offerId: _offerId, listing: _listing, ...updatable } = offer;
  const updatedOffer = {
    ...updatable,
    pricingSummary: {
      ...offer.pricingSummary,
      price: { value: Number(newPrice).toFixed(2), currency },
    },
  };

  await ebayRequest(refreshToken, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, updatedOffer);

  return { offerId, newPrice: updatedOffer.pricingSummary.price.value, currency };
}

/**
 * Fetches a user's eBay Business Policies (payment/return/fulfillment) and
 * Inventory Locations, so the Settings page can offer them as dropdowns
 * instead of requiring the user to manually copy IDs from Seller Hub.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} marketplaceId - e.g. "EBAY_US" (policies are marketplace-specific)
 */
async function fetchBusinessPolicies(refreshToken, marketplaceId = 'EBAY_US') {
  const query = `?marketplace_id=${encodeURIComponent(marketplaceId)}`;

  // Run all four lookups in parallel. If a seller hasn't opted into Business
  // Policies yet, eBay returns an error for the policy calls specifically -
  // we treat that as "no policies configured" rather than a hard failure,
  // since the user can still set things up and try again.
  const [paymentResult, returnResult, fulfillmentResult, locationResult] = await Promise.allSettled([
    ebayRequest(refreshToken, 'GET', `/sell/account/v1/payment_policy${query}`),
    ebayRequest(refreshToken, 'GET', `/sell/account/v1/return_policy${query}`),
    ebayRequest(refreshToken, 'GET', `/sell/account/v1/fulfillment_policy${query}`),
    ebayRequest(refreshToken, 'GET', '/sell/inventory/v1/location'),
  ]);

  const extractList = (result, key) =>
    result.status === 'fulfilled' && Array.isArray(result.value?.[key]) ? result.value[key] : [];

  const paymentPolicies = extractList(paymentResult, 'paymentPolicies').map((p) => ({
    id: p.paymentPolicyId,
    name: p.name,
  }));
  const returnPolicies = extractList(returnResult, 'returnPolicies').map((p) => ({
    id: p.returnPolicyId,
    name: p.name,
  }));
  const fulfillmentPolicies = extractList(fulfillmentResult, 'fulfillmentPolicies').map((p) => ({
    id: p.fulfillmentPolicyId,
    name: p.name,
  }));
  const locations = extractList(locationResult, 'locations').map((l) => ({
    key: l.merchantLocationKey,
    name: l.name || l.merchantLocationKey,
  }));

  return { paymentPolicies, returnPolicies, fulfillmentPolicies, locations };
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
async function createOrGetCustomLocation(refreshToken, countryCode, postalCode) {
  // Deterministic key based on the country+postal code, so calling this
  // again with the same values reuses the same location instead of
  // creating duplicates.
  const locationKey = `elms-custom-${countryCode.toLowerCase()}-${postalCode.replace(/[^a-z0-9]/gi, '')}`.slice(0, 50);

  try {
    await ebayRequest(refreshToken, 'POST', `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`, {
      location: {
        address: {
          country: countryCode.toUpperCase(),
          postalCode: postalCode,
        },
      },
      name: `ELMS custom location (${postalCode}, ${countryCode.toUpperCase()})`,
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE'],
    });
  } catch (err) {
    // eBay returns a 409-style "already exists" style error if this
    // location key was already created in a previous call - that's fine,
    // we just reuse it. Any other error should still surface.
    const alreadyExists = err.statusCode === 409 || /already exists/i.test(err.message || '');
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

  // Prefer the category-aware aspects assembled by the ELMS UI. This lets
  // Amazon specifications be mapped into eBay's exact aspect names.
  if (product.ebayAspects && typeof product.ebayAspects === 'object') {
    for (const [name, value] of Object.entries(product.ebayAspects)) {
      const values = Array.isArray(value) ? value : [value];
      const clean = values.map(v => String(v ?? '').trim().slice(0, 65)).filter(Boolean).slice(0, 30);
      if (name && clean.length) aspects[name] = clean;
    }
  }

  if (product.brand && !aspects.Brand) aspects.Brand = [String(product.brand).trim().slice(0, 65)];

  (product.specifications || []).forEach((spec) => {
    if (spec.name && spec.value && !aspects[spec.name]) aspects[spec.name] = [String(spec.value).trim().slice(0, 65)];
  });

  return aspects;
}

module.exports = { publishListing, withdrawListing, updateOfferPrice, fetchBusinessPolicies, createOrGetCustomLocation };
