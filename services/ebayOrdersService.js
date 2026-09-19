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
 * Fetches orders from eBay's Fulfillment API for the given seller account.
 *
 * `sinceDate` is matched against the order's LAST MODIFIED time (not its
 * creation time), so an order that was created long ago but has just been paid,
 * shipped, cancelled or returned is fetched again and its status stays current.
 * Pages of 200 (eBay's maximum) are read until eBay has no more.
 *
 * @param {string} refreshToken
 * @param {Date|null} sinceDate
 * @returns {Promise<Array>} raw eBay order objects
 */
async function fetchOrders(refreshToken, sinceDate) {
  const allOrders = [];
  const limit = 200;
  let offset = 0;

  for (let page = 0; page < 50; page++) {
    const filter = sinceDate
      ? `&filter=${encodeURIComponent(`lastmodifieddate:[${sinceDate.toISOString()}..]`)}`
      : '';
    const data = await ebayGet(refreshToken, `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}${filter}`);
    const orders = Array.isArray(data.orders) ? data.orders : [];
    allOrders.push(...orders);
    if (orders.length < limit) break;
    offset += limit;
  }
  return allOrders;
}

/** Fetches ONE order (used to refresh a single order on demand). */
async function fetchOrderById(refreshToken, ebayOrderId) {
  return ebayGet(refreshToken, `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}`);
}

const money = (v) => {
  const n = parseFloat(v?.value);
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Converts one raw eBay order into one normalized entry per line item, which
 * is how ELMS tracks fulfillment. Every line item is kept - including ones
 * that are not ELMS listings (no SKU) - so the Orders page always shows every
 * eBay order the seller has.
 */
function normalizeOrderLineItems(rawOrder) {
  const lineItems = Array.isArray(rawOrder.lineItems) ? rawOrder.lineItems : [];

  const instruction = rawOrder.fulfillmentStartInstructions?.[0];
  const step = instruction?.shippingStep;
  const shipTo = step?.shipTo;
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

  const payment = Array.isArray(rawOrder.paymentSummary?.payments) ? rawOrder.paymentSummary.payments[0] : null;
  const orderTotal = money(rawOrder.pricingSummary?.total);

  return lineItems.map((item) => {
    const variantDetails = Array.isArray(item.lineItemProperties) && item.lineItemProperties.length
      ? item.lineItemProperties.map((p) => `${p.name}: ${p.value}`).join(', ')
      : null;
    const fulfillment = item.lineItemFulfillmentInstructions || {};
    const taxes = Array.isArray(item.taxes) ? item.taxes.reduce((sum, t) => sum + (money(t.amount) || 0), 0) : null;

    return {
      ebayOrderId: rawOrder.orderId,
      ebayLineItemId: item.lineItemId || null,
      // A line without a SKU still needs a stable, unique key for the (order, sku) index.
      sku: item.sku || `EBAY-${item.legacyItemId || item.lineItemId}`,
      buyerUsername: rawOrder.buyer?.username || null,
      salePrice: money(item.lineItemCost),
      quantity: item.quantity || 1,
      variantDetails,
      shippingAddress,
      createdAt: toDate(rawOrder.creationDate) || new Date(),
      ebayOrderFulfillmentStatus: rawOrder.orderFulfillmentStatus || null,
      ebayPaymentStatus: rawOrder.orderPaymentStatus || null,
      ebayCancelStatus: rawOrder.cancelStatus?.cancelState || rawOrder.cancelStatus?.cancelStatus || null,

      itemTitle: item.title || null,
      legacyItemId: item.legacyItemId || null,
      currency: item.lineItemCost?.currency || rawOrder.pricingSummary?.total?.currency || null,
      deliveryCost: money(item.deliveryCost?.shippingCost),
      tax: taxes,
      lineTotal: money(item.total),
      orderTotal,
      buyerEmail: shipTo?.email || null,
      buyerPhone: shipTo?.primaryPhone?.phoneNumber || null,
      buyerNote: rawOrder.buyerCheckoutNotes || null,
      salesRecord: rawOrder.salesRecordReference || null,
      marketplaceId: item.purchaseMarketplaceId || null,
      shippingService: step?.shippingServiceCode || null,
      lineItemStatus: item.lineItemFulfillmentStatus || null,
      ebayCreatedAt: toDate(rawOrder.creationDate),
      ebayModifiedAt: toDate(rawOrder.lastModifiedDate),
      paidAt: toDate(payment?.paymentDate),
      shipByDate: toDate(fulfillment.shipByDate),
      estDeliveryMin: toDate(fulfillment.minEstimatedDeliveryDate),
      estDeliveryMax: toDate(fulfillment.maxEstimatedDeliveryDate),
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

module.exports = { fetchOrders, fetchOrderById, normalizeOrderLineItems, createShippingFulfillment };
