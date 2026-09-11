const Order = require('./schemas/Order');
const Listing = require('./schemas/Listing');
const Import = require('./schemas/Import');

/**
 * Creates or updates one order line item from an eBay sync, matched by
 * (userId, ebayOrderId, sku) so re-running the sync never creates
 * duplicates. Looks up the matching listing by SKU so the order can be
 * linked to it (for displaying the product title/image).
 *
 * @param {string} userId
 * @param {object} orderLineItem
 * @param {string} ebayAccountId - which of the user's eBay accounts this order came from
 */
async function upsertOrder(userId, orderLineItem, ebayAccountId) {
  const listing = orderLineItem.sku
    ? await Listing.findOne({ userId, sku: orderLineItem.sku })
    : null;

  const doc = await Order.findOneAndUpdate(
    { userId, ebayOrderId: orderLineItem.ebayOrderId, sku: orderLineItem.sku },
    {
      userId,
      ebayAccountId: ebayAccountId || null,
      listingId: listing ? listing._id : null,
      ebayOrderId: orderLineItem.ebayOrderId,
      ebayLineItemId: orderLineItem.ebayLineItemId || null,
      sku: orderLineItem.sku,
      buyerUsername: orderLineItem.buyerUsername,
      salePrice: orderLineItem.salePrice,
      quantity: orderLineItem.quantity,
      variantDetails: orderLineItem.variantDetails || null,
      shippingAddress: orderLineItem.shippingAddress || undefined,
    },
    { new: true, upsert: true }
  );

  return serialize(doc);
}

/**
 * Returns all of a user's orders across ALL of their connected eBay
 * accounts (a combined view, like AutoDS's multi-store dashboard).
 * Optionally filter to just one account with accountId.
 *
 * Joins in the Amazon buy price (from the linked Import record, via the
 * Listing) so the frontend can show Buy Price and calculate Profit without
 * an extra API call.
 */
async function listOrders(userId, accountId) {
  const query = accountId ? { userId, ebayAccountId: accountId } : { userId };
  const docs = await Order.find(query)
    .populate({ path: 'listingId', populate: { path: 'importId' } })
    .populate('ebayAccountId')
    .sort({ createdAt: -1 });

  return docs.map((doc) => {
    const serialized = serialize(doc);
    const listing = doc.listingId;
    const importRecord = listing?.importId;

    serialized.listing_title = listing?.title || null;
    serialized.main_image = listing?.mainImage || null;
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    serialized.buy_price = importRecord?.amazonPrice ?? null;

    if (serialized.buy_price != null && serialized.sale_price != null) {
      serialized.profit = Number((serialized.sale_price - serialized.buy_price * (serialized.quantity || 1)).toFixed(2));
    } else {
      serialized.profit = null;
    }

    return serialized;
  });
}

async function getOrderById(userId, id) {
  const doc = await Order.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

async function updateFulfillmentStatus(userId, id, fulfillmentStatus, amazonOrderId) {
  const update = { fulfillmentStatus };
  if (amazonOrderId) update.amazonOrderId = amazonOrderId;

  const doc = await Order.findOneAndUpdate({ _id: id, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

/**
 * Saves a tracking number/carrier for an order and marks it as shipped.
 */
async function setTracking(userId, id, trackingNumber, shippingCarrier) {
  const doc = await Order.findOneAndUpdate(
    { _id: id, userId },
    { trackingNumber, shippingCarrier, fulfillmentStatus: 'shipped' },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    ebay_account_id: obj.ebayAccountId ? (obj.ebayAccountId._id || obj.ebayAccountId).toString() : null,
    listing_id: obj.listingId ? (obj.listingId._id || obj.listingId).toString() : null,
    ebay_order_id: obj.ebayOrderId,
    ebay_line_item_id: obj.ebayLineItemId,
    sku: obj.sku,
    buyer_username: obj.buyerUsername,
    sale_price: obj.salePrice,
    quantity: obj.quantity,
    variant_details: obj.variantDetails,
    shipping_address: obj.shippingAddress || null,
    tracking_number: obj.trackingNumber,
    shipping_carrier: obj.shippingCarrier,
    fulfillment_status: obj.fulfillmentStatus,
    amazon_order_id: obj.amazonOrderId,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

module.exports = { listOrders, getOrderById, updateFulfillmentStatus, upsertOrder, setTracking };
