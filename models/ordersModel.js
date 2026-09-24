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
  // Items that are not ELMS listings have no SKU to match. If the seller linked an earlier order of the same eBay item
  // to a product (Import from Amazon), a new order of that item follows it.
  let listingId = listing ? listing._id : null;
  if (!listingId && orderLineItem.legacyItemId) {
    const earlier = await Order.findOne({ userId, legacyItemId: orderLineItem.legacyItemId, listingId: { $ne: null } }).select('listingId').lean();
    listingId = earlier ? earlier.listingId : null;
  }

  const fields = {
    ebayAccountId: ebayAccountId || null,
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
  // never erase a link the seller made (eBay's order data cannot say which product an item is)
  if (listingId) fields.listingId = listingId;
  if (orderLineItem.shippingAddress) fields.shippingAddress = orderLineItem.shippingAddress;
  if (orderLineItem.itemImage) fields.itemImage = orderLineItem.itemImage; // never overwrite a stored picture with nothing

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
const positive = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : null; };

/**
 * An order is linked to its listing by SKU when it is first saved. Orders that are not linked (the listing was made or
 * published later, or eBay's SKU differs) get their listing found here by SKU or by eBay item number, so title, picture and
 * cost still show. Read-only: nothing is written.
 */
async function attachMissingListings(userId, docs) {
  const loose = docs.filter((d) => !d.listingId);
  if (!loose.length) return docs;
  const skus = [...new Set(loose.map((d) => d.sku).filter((s) => s && !/^EBAY-/.test(s)))];
  const itemIds = [...new Set(loose.map((d) => d.legacyItemId).filter(Boolean))];
  if (!skus.length && !itemIds.length) return docs;
  const found = await Listing.find({ userId, $or: [...(skus.length ? [{ sku: { $in: skus } }] : []), ...(itemIds.length ? [{ ebayListingId: { $in: itemIds } }] : [])] })
    .populate('importId').lean();
  const accountOf = (x) => String((x && (x._id || x)) || '');
  for (const d of loose) {
    const matches = found.filter((l) => (d.sku && l.sku === d.sku) || (d.legacyItemId && l.ebayListingId === d.legacyItemId));
    const listing = matches.find((l) => accountOf(l.ebayAccountId) === accountOf(d.ebayAccountId)) || matches[0];
    if (listing) d.listingId = listing;
  }
  return docs;
}

async function listOrders(userId, accountId) {
  const query = accountId ? { userId, ebayAccountId: accountId } : { userId };
  const docs = await Order.find(query)
    .populate({ path: 'listingId', populate: { path: 'importId' } })
    .populate('ebayAccountId')
    .sort({ ebayCreatedAt: -1, createdAt: -1 })
    .lean();
  await attachMissingListings(userId, docs);

  return docs.map((doc) => enrichOrder(serialize(doc), doc));
}

/**
 * Fills in the fields that need the linked listing/import/account (title,
 * image, buy price, profit) on top of the plain serialized order. Shared by
 * listOrders and getOrderById so a single order fetched after an action
 * (refresh, mark shipped, save note...) looks exactly like it does in the list,
 * instead of the drawer briefly losing its image/title/profit.
 */
function enrichOrder(serialized, doc) {
  const listing = doc.listingId;
  const importRecord = listing?.importId;

  // Prefer the listing's saved Amazon price snapshot. This keeps historical
  // order profit stable even if the source/import price changes later.
  const savedAmazonPrice = positive(doc.buyPriceOverride) ?? positive(listing?.amazonPrice) ?? positive(importRecord?.amazonPrice) ?? positive(importRecord?.product?.price);
  serialized.buy_price_manual = positive(doc.buyPriceOverride) !== null;

  serialized.listing_title = listing?.title || serialized.item_title || null;
  // Fall back to eBay's own picture for the line item (item.image.imageUrl)
  // when the order has no linked ELMS listing - the common case for orders
  // synced straight from eBay that were never imported/published via ELMS.
  serialized.main_image = listing?.mainImage || doc.itemImage || null;
  serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
  serialized.buy_price = savedAmazonPrice;

  if (serialized.buy_price != null && serialized.sale_price != null) {
    serialized.profit = Number((serialized.sale_price - serialized.buy_price * (serialized.quantity || 1)).toFixed(2));
  } else {
    serialized.profit = null;
  }

  return serialized;
}

async function getOrderById(userId, id) {
  const doc = await Order.findOne({ _id: id, userId })
    .populate({ path: 'listingId', populate: { path: 'importId' } })
    .populate('ebayAccountId')
    .lean();
  if (doc) await attachMissingListings(userId, [doc]);
  return doc ? enrichOrder(serialize(doc), doc) : null;
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

/**
 * Links an order to one of the user's listings (a product imported for it) so its cost, title and picture come from there.
 * Other orders of the same eBay item that have no listing follow. Returns the number of orders linked, or null when the
 * order or the listing is not this user's.
 */
async function linkOrderToListing(userId, id, listingId) {
  const [order, listing] = await Promise.all([
    Order.findOne({ _id: id, userId }).select('ebayAccountId legacyItemId').lean(),
    Listing.findOne({ _id: listingId, userId }).select('_id').lean(),
  ]);
  if (!order || !listing) return null;
  await Order.updateOne({ _id: id, userId }, { $set: { listingId: listing._id } });
  let linked = 1;
  if (order.legacyItemId) {
    const more = await Order.updateMany({ userId, ebayAccountId: order.ebayAccountId, legacyItemId: order.legacyItemId, listingId: null }, { $set: { listingId: listing._id } });
    linked += Number(more && (more.modifiedCount ?? more.nModified) || 0);
  }
  return linked;
}

/** The seller's own cost of one unit (null clears it). Used for profit when the listing / import carry no price. */
async function setBuyPrice(userId, id, price) {
  const value = price === null || price === '' || price === undefined ? null : Number(price);
  if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 1000000)) throw new Error('Enter the cost of one item as a number above 0.');
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { buyPriceOverride: value === null ? null : Number(value.toFixed(2)) }, { new: true });
  return doc ? serialize(doc) : null;
}

async function setSellerNote(userId, id, note) {
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { sellerNote: String(note || '').slice(0, 2000) }, { new: true });
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  // Accepts either a real Mongoose document or a plain object from .lean()
  // (listOrders uses .lean() - skips document hydration, much faster for a
  // user with a lot of order history).
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
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

module.exports = { listOrders, getOrderById, updateFulfillmentStatus, upsertOrder, setTracking, linkAmazonOrder, setSellerNote, setBuyPrice, linkOrderToListing, deriveOrderStatus };
