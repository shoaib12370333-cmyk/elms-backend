const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');

const EBAY_BASE_URL = 'https://api.ebay.com';

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

  return lineItems.map((item) => ({
    ebayOrderId: rawOrder.orderId,
    sku: item.sku || null,
    buyerUsername: rawOrder.buyer?.username || null,
    salePrice: item.lineItemCost?.value ? parseFloat(item.lineItemCost.value) : null,
    quantity: item.quantity || 1,
    createdAt: rawOrder.creationDate ? new Date(rawOrder.creationDate) : new Date(),
  }));
}

module.exports = { fetchOrders, normalizeOrderLineItems };
