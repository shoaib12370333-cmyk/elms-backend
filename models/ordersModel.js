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
    ? ((ebayAccountId && await Listing.findOne({ userId, sku: orderLineItem.sku, ebayAccountId }))
        || await Listing.findOne({ userId, sku: orderLineItem.sku }))
    : null;

  const fields = {
    ebayAccountId: ebayAccountId || null,
    listingId: listing ? listing._id : null,
    ebayOrderId: orderLineItem.ebayOrderId,
    ebayLineItemId: orderLineItem.ebayLineItemId || null,
    sku: orderLineItem.sku,
    buyerUsername: orderLineItem.buyerUsername,
    salePrice: orderLineItem.salePrice,
    quantity: orderLineItem.quantity,
    variantDetails: orderLineItem.variantDetails || null,
    ebayOrderFulfillmentStatus: orderLineItem.ebayOrderFulfillmentStatus || null,
    ebayPaymentStatus: orderLineItem.ebayPaymentStatus || null,
    ebayCancelStatus: orderLineItem.ebayCancelStatus || null,
    itemTitle: orderLineItem.itemTitle || null,
    legacyItemId: orderLineItem.legacyItemId || null,
    currency: orderLineItem.currency || null,
    deliveryCost: orderLineItem.deliveryCost ?? null,
    tax: orderLineItem.tax ?? null,
    lineTotal: orderLineItem.lineTotal ?? null,
    orderTotal: orderLineItem.orderTotal ?? null,
    buyerEmail: orderLineItem.buyerEmail || null,
    buyerPhone: orderLineItem.buyerPhone || null,
    buyerNote: orderLineItem.buyerNote || null,
    salesRecord: orderLineItem.salesRecord || null,
    marketplaceId: orderLineItem.marketplaceId || null,
    shippingService: orderLineItem.shippingService || null,
    lineItemStatus: orderLineItem.lineItemStatus || null,
    ebayCreatedAt: orderLineItem.ebayCreatedAt || null,
    ebayModifiedAt: orderLineItem.ebayModifiedAt || null,
    paidAt: orderLineItem.paidAt || null,
    shipByDate: orderLineItem.shipByDate || null,
    estDeliveryMin: orderLineItem.estDeliveryMin || null,
    estDeliveryMax: orderLineItem.estDeliveryMax || null,
  };
  if (orderLineItem.shippingAddress) fields.shippingAddress = orderLineItem.shippingAddress;

  // Match by eBay's line item ID first (rows synced before SKUs were made unique
  // may have a null SKU), then by SKU, so a re-sync never duplicates an order.
  const findExisting = async () => {
    let doc = orderLineItem.ebayLineItemId
      ? await Order.findOne({ userId, ebayOrderId: orderLineItem.ebayOrderId, ebayLineItemId: orderLineItem.ebayLineItemId })
      : null;
    if (!doc) doc = await Order.findOne({ userId, ebayOrderId: orderLineItem.ebayOrderId, sku: orderLineItem.sku });
    return doc;
  };

  let doc = await findExisting();
  try {
    if (doc) {
      doc.set(fields);
      // eBay already shows the item as shipped -> keep ELMS in step (never move backwards).
      if (['FULFILLED'].includes(fields.lineItemStatus) && doc.fulfillmentStatus === 'pending') doc.fulfillmentStatus = 'shipped';
      await doc.save();
    } else {
      doc = await Order.create({
        userId,
        ...fields,
        fulfillmentStatus: fields.lineItemStatus === 'FULFILLED' ? 'shipped' : 'pending',
      });
    }
  } catch (err) {
    // Two syncs (webhook + job) inserted the same row at once: update the winner instead.
    if (err && err.code === 11000) {
      doc = await findExisting();
      if (!doc) throw err;
      doc.set(fields);
      await doc.save();
    } else {
      throw err;
    }
  }

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
    .sort({ ebayCreatedAt: -1, createdAt: -1 });

  return docs.map((doc) => {
    const serialized = serialize(doc);
    const listing = doc.listingId;
    const importRecord = listing?.importId;

    // Prefer the listing's saved Amazon price snapshot. This keeps historical
    // order profit stable even if the source/import price changes later.
    const savedAmazonPrice = listing?.amazonPrice ?? importRecord?.amazonPrice ?? null;

    serialized.listing_title = listing?.title || serialized.item_title || null;
    serialized.main_image = listing?.mainImage || null;
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    serialized.buy_price = savedAmazonPrice;

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

async function linkAmazonOrder(userId, id, amazonOrderId, fulfillmentStatus = 'ordered_from_amazon') {
  const value = String(amazonOrderId || '').trim();
  if (!value) throw new Error('An Amazon order ID is required.');
  const allowed = ['pending', 'ordered_from_amazon', 'shipped', 'delivered'];
  if (!allowed.includes(fulfillmentStatus)) throw new Error('Invalid fulfillment status.');

  const doc = await Order.findOneAndUpdate(
    { _id: id, userId },
    { amazonOrderId: value, fulfillmentStatus },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * The status a seller sees on eBay: awaiting payment -> awaiting shipment ->
 * shipped -> delivered, or cancelled. Combines eBay's own status fields with
 * what the seller recorded in ELMS.
 */
function deriveOrderStatus(obj) {
  const cancel = String(obj.ebayCancelStatus || '').toUpperCase();
  if (cancel === 'CANCELED' || cancel === 'CANCELLED') return 'cancelled';
  const payment = String(obj.ebayPaymentStatus || '').toUpperCase();
  if (payment === 'PENDING' || payment === 'FAILED') return 'awaiting_payment';
  if (obj.fulfillmentStatus === 'delivered') return 'delivered';
  const line = String(obj.lineItemStatus || '').toUpperCase();
  const overall = String(obj.ebayOrderFulfillmentStatus || '').toUpperCase();
  if (obj.fulfillmentStatus === 'shipped' || line === 'FULFILLED' || overall === 'FULFILLED') return 'shipped';
  return 'awaiting_shipment';
}

async function setSellerNote(userId, id, note) {
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { sellerNote: String(note || '').slice(0, 2000) }, { new: true });
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
    ebay_order_fulfillment_status: obj.ebayOrderFulfillmentStatus || null,
    ebay_payment_status: obj.ebayPaymentStatus || null,
    ebay_cancel_status: obj.ebayCancelStatus || null,
    item_title: obj.itemTitle || null,
    legacy_item_id: obj.legacyItemId || null,
    currency: obj.currency || null,
    delivery_cost: obj.deliveryCost ?? null,
    tax: obj.tax ?? null,
    line_total: obj.lineTotal ?? null,
    order_total: obj.orderTotal ?? null,
    buyer_email: obj.buyerEmail || null,
    buyer_phone: obj.buyerPhone || null,
    buyer_note: obj.buyerNote || null,
    sales_record: obj.salesRecord || null,
    marketplace_id: obj.marketplaceId || null,
    shipping_service: obj.shippingService || null,
    line_item_status: obj.lineItemStatus || null,
    ebay_created_at: obj.ebayCreatedAt || obj.createdAt,
    ebay_modified_at: obj.ebayModifiedAt || null,
    paid_at: obj.paidAt || null,
    ship_by_date: obj.shipByDate || null,
    est_delivery_min: obj.estDeliveryMin || null,
    est_delivery_max: obj.estDeliveryMax || null,
    seller_note: obj.sellerNote || '',
    order_status: deriveOrderStatus(obj),
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

module.exports = { listOrders, getOrderById, updateFulfillmentStatus, upsertOrder, setTracking, linkAmazonOrder, setSellerNote, deriveOrderStatus };
