const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

/**
 * Sends an authenticated GET request to eBay's Fulfillment API on behalf of
 * a specific user's refresh token.
 */
async function ebayGet(refreshToken, path) {
  const accessToken = await getAccessToken(refreshToken);

  try {
    const response = await axios.get(`${EBAY_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
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
    throw wrapped;
  }
}

/**
 * Sends an authenticated POST request to eBay's Fulfillment API.
 */
async function ebayPost(refreshToken, path, body) {
  const accessToken = await getAccessToken(refreshToken);

  try {
    const response = await axios.post(`${EBAY_BASE_URL}${path}`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
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
    throw wrapped;
  }
}

/**
 * Fetches orders from eBay's Fulfillment API for the given user, optionally
 * only those created after a given date (used for incremental syncing so we
 * don't re-fetch orders we already have every time).
 *
 * @param {string} refreshToken
 * @param {Date|null} sinceDate - only return orders created after this date
 * @returns {Promise<Array>} raw eBay order objects
 */
async function fetchOrders(refreshToken, sinceDate) {
  let allOrders = [];
  let offset = 0;
  const limit = 50;

  // eBay paginates orders - loop until there are no more pages. Capped at
  // 10 pages (500 orders) per sync run as a safety limit.
  for (let page = 0; page < 10; page++) {
    let filter = '';
    if (sinceDate) {
      filter = `&filter=${encodeURIComponent(`creationdate:[${sinceDate.toISOString()}..]`)}`;
    }

    const data = await ebayGet(
      refreshToken,
      `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}${filter}`
    );

    const orders = Array.isArray(data.orders) ? data.orders : [];
    allOrders = allOrders.concat(orders);

    if (orders.length < limit) break; // no more pages
    offset += limit;
  }

  return allOrders;
}

/**
 * Converts one raw eBay order object into the simple shape our database
 * stores. An eBay order can contain multiple line items (different SKUs) -
 * we return one normalized entry per line item, since our Order model
 * tracks fulfillment per listing.
 */
function normalizeOrderLineItems(rawOrder) {
  const lineItems = Array.isArray(rawOrder.lineItems) ? rawOrder.lineItems : [];

  const shipTo = rawOrder.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const shippingAddress = shipTo
    ? {
        fullName: shipTo.fullName || null,
        addressLine1: shipTo.contactAddress?.addressLine1 || null,
        addressLine2: shipTo.contactAddress?.addressLine2 || null,
        city: shipTo.contactAddress?.city || null,
        stateOrProvince: shipTo.contactAddress?.stateOrProvince || null,
        postalCode: shipTo.contactAddress?.postalCode || null,
        country: shipTo.contactAddress?.countryCode || null,
      }
    : null;

  return lineItems.map((item) => {
    // Variant details (e.g. "Color: Blue, Size: Large") come back as an
    // array of { name, value } pairs when the listing has variations.
    const variantDetails = Array.isArray(item.lineItemProperties) && item.lineItemProperties.length
      ? item.lineItemProperties.map((p) => `${p.name}: ${p.value}`).join(', ')
      : null;

    return {
      ebayOrderId: rawOrder.orderId,
      ebayLineItemId: item.lineItemId || null,
      sku: item.sku || null,
      buyerUsername: rawOrder.buyer?.username || null,
      salePrice: item.lineItemCost?.value ? parseFloat(item.lineItemCost.value) : null,
      quantity: item.quantity || 1,
      variantDetails,
      shippingAddress,
      createdAt: rawOrder.creationDate ? new Date(rawOrder.creationDate) : new Date(),
    };
  });
}

/**
 * Attaches a tracking number to an order line item on eBay, marking it as
 * shipped from the buyer's perspective. Called when the seller enters a
 * tracking number in ELMS after shipping the item from Amazon.
 *
 * @param {string} refreshToken
 * @param {string} ebayOrderId
 * @param {string} ebayLineItemId
 * @param {number} quantity
 * @param {string} trackingNumber
 * @param {string} shippingCarrier - eBay's carrier code, e.g. "USPS", "FEDEX", "UPS"
 */
async function createShippingFulfillment(refreshToken, ebayOrderId, ebayLineItemId, quantity, trackingNumber, shippingCarrier) {
  return ebayPost(refreshToken, `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}/shipping_fulfillment`, {
    lineItems: [{ lineItemId: ebayLineItemId, quantity: quantity || 1 }],
    shippedDate: new Date().toISOString(),
    shippingCarrierCode: shippingCarrier || 'OTHER',
    trackingNumber,
  });
}

module.exports = { fetchOrders, normalizeOrderLineItems, createShippingFulfillment };
