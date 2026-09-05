const Order = require('./schemas/Order');
const Listing = require('./schemas/Listing');

/**
 * Creates or updates one order line item from an eBay sync, matched by
 * (userId, ebayOrderId, sku) so re-running the sync never creates
 * duplicates. Looks up the matching listing by SKU so the order can be
 * linked to it (for displaying the product title/image).
 */
async function upsertOrder(userId, orderLineItem) {
  const listing = orderLineItem.sku
    ? await Listing.findOne({ userId, sku: orderLineItem.sku })
    : null;

  const doc = await Order.findOneAndUpdate(
    { userId, ebayOrderId: orderLineItem.ebayOrderId, sku: orderLineItem.sku },
    {
      userId,
      listingId: listing ? listing._id : null,
      ebayOrderId: orderLineItem.ebayOrderId,
      sku: orderLineItem.sku,
      buyerUsername: orderLineItem.buyerUsername,
      salePrice: orderLineItem.salePrice,
      quantity: orderLineItem.quantity,
    },
    { new: true, upsert: true }
  );

  return serialize(doc);
}

async function listOrders(userId) {
  const docs = await Order.find({ userId }).populate('listingId').sort({ createdAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.listing_title = doc.listingId?.title || null;
    serialized.main_image = doc.listingId?.mainImage || null;
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

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    listing_id: obj.listingId ? obj.listingId.toString() : null,
    ebay_order_id: obj.ebayOrderId,
    buyer_username: obj.buyerUsername,
    sale_price: obj.salePrice,
    quantity: obj.quantity,
    fulfillment_status: obj.fulfillmentStatus,
    amazon_order_id: obj.amazonOrderId,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

module.exports = { listOrders, getOrderById, updateFulfillmentStatus, upsertOrder };
