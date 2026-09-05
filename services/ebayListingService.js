const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');

const EBAY_BASE_URL = 'https://api.ebay.com';

/**
 * A small helper that sends an authenticated request to eBay (on behalf of
 * a specific user's refresh token) and turns eBay-style error objects into
 * a readable message.
 */
async function ebayRequest(refreshToken, method, path, body) {
  const accessToken = await getAccessToken(refreshToken);

  try {
    const response = await axios({
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
      imageUrls: (product.images || []).slice(0, 12), // eBay max 12 images
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
        currency: 'USD',
      },
    },
    listingPolicies: {
      paymentPolicyId,
      fulfillmentPolicyId,
      returnPolicyId,
    },
  };

  const offerResult = await ebayRequest(refreshToken, 'POST', '/sell/inventory/v1/offer', offerBody);
  const offerId = offerResult.offerId;

  if (!offerId) {
    throw new Error('eBay did not return an offerId, so the offer could not be created.');
  }

  // ---------- Step 3: Publish Offer ----------
  const publishResult = await ebayRequest(
    refreshToken,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`
  );

  return {
    sku: finalSku,
    offerId,
    listingId: publishResult.listingId || null,
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
 * Builds eBay "item specifics" (aspects) from the product's brand/specifications.
 * eBay expects a format like { "Brand": ["Bose"], "Color": ["Black"] }.
 */
function buildAspects(product) {
  const aspects = {};

  if (product.brand) {
    aspects['Brand'] = [product.brand];
  }

  (product.specifications || []).forEach((spec) => {
    if (spec.name && spec.value && !aspects[spec.name]) {
      aspects[spec.name] = [spec.value];
    }
  });

  return aspects;
}

module.exports = { publishListing, withdrawListing, fetchBusinessPolicies };
