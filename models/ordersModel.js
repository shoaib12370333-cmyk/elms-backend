const mongoose = require('mongoose');
const Order = require('./schemas/Order');
const Listing = require('./schemas/Listing');
const Import = require('./schemas/Import');
const { warmRates, convertCached } = require('../services/currencyService');
const { sourceCurrency } = require('../config/amazonDomains');
const { accountLabel, publicUsername } = require('../services/accountLabel');

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
const { buildLine: buildNetProfitLine, resolveNetProfit } = require('../services/netProfitService');
const { applyMark } = require('../services/orderNoteMark');
// What an order needs from its listing (title, picture, cost), that listing's import (the Amazon link and price) and its store; the rest stays in the database.
const LISTING_FOR_ORDER = { path: 'listingId', select: 'title mainImage amazonPrice sku currency importId ebayListingId ebayAccountId', populate: { path: 'importId', select: 'amazonUrl amazonPrice currency product.price product.currency' } };
const ACCOUNT_FOR_ORDER = { path: 'ebayAccountId', select: 'displayName storeName ebayUserId storeNumber' };
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
    .select('sku ebayListingId ebayAccountId title mainImage amazonPrice currency importId').populate({ path: 'importId', select: 'amazonUrl amazonPrice currency product.price product.currency' }).lean();
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
    .populate(LISTING_FOR_ORDER)
    .populate(ACCOUNT_FOR_ORDER)
    .sort({ ebayCreatedAt: -1, createdAt: -1 })
    .lean();
  await attachMissingListings(userId, docs);
  if (needsRates(docs)) await warmRates();

  return docs.map((doc) => enrichOrder(serialize(doc), doc));
}

/**
 * Fills in the fields that need the linked listing/import/account (title,
 * image, buy price, profit) on top of the plain serialized order. Shared by
 * listOrders and getOrderById so a single order fetched after an action
 * (refresh, mark shipped, save note...) looks exactly like it does in the list,
 * instead of the drawer briefly losing its image/title/profit.
 */
/** The currency the cost of an order's item is in: the seller's own figure is in the sale's currency, the rest is the Amazon site's. */
function costCurrencyOf(doc) {
  if (positive(doc.buyPriceOverride) !== null) return doc.currency || null;
  const listing = doc.listingId;
  // The Amazon site the product was read from decides; then what was saved with the listing / import.
  return sourceCurrency(listing?.importId?.amazonUrl, listing?.currency || listing?.importId?.currency || listing?.importId?.product?.currency);
}
const upper = (c) => (c ? String(c).toUpperCase() : null);
/** True when some order's cost is in another currency than its sale, so exchange rates are needed to work out the profit. */
const needsRates = (docs) => docs.some((d) => upper(costCurrencyOf(d)) && upper(d.currency) && upper(costCurrencyOf(d)) !== upper(d.currency));

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
  serialized.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
  serialized.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
  serialized.buy_price = savedAmazonPrice;
  // Where the product is on Amazon (the link of the import the listing was made from), so an order shows the same eBay and Amazon links as a live listing.
  serialized.asin = listing?.sku || doc.sku || null;
  serialized.amazon_url = importRecord?.amazonUrl || null;

  // The sale is in the eBay site's currency and the cost in the Amazon site's. They are usually the same (a UK store sells
  // items from amazon.co.uk), but not always (a site with no Amazon of its own, an old draft): then the cost is converted
  // first, so profit is never "GBP 20 - USD 15".
  const saleCurrency = upper(doc.currency);
  const costCurrency = upper(costCurrencyOf(doc));
  serialized.buy_price_currency = costCurrency || saleCurrency || null;
  if (serialized.buy_price != null && saleCurrency && costCurrency && costCurrency !== saleCurrency) {
    const converted = convertCached(serialized.buy_price, costCurrency, saleCurrency);
    if (converted == null) {
      serialized.profit = null;
      serialized.profit_note = `The cost is in ${costCurrency} and the sale in ${saleCurrency}, and no exchange rate is available right now.`;
      return serialized;
    }
    serialized.buy_price_original = { amount: serialized.buy_price, currency: costCurrency };
    serialized.buy_price = converted;
    serialized.buy_price_currency = saleCurrency;
  }

  if (serialized.buy_price != null && serialized.sale_price != null) {
    serialized.profit = Number((serialized.sale_price - serialized.buy_price * (serialized.quantity || 1)).toFixed(2));
  } else {
    serialized.profit = null;
  }

  return serialized;
}

async function getOrderById(userId, id) {
  const doc = await Order.findOne({ _id: id, userId })
    .populate(LISTING_FOR_ORDER)
    .populate(ACCOUNT_FOR_ORDER)
    .lean();
  if (doc) await attachMissingListings(userId, [doc]);
  if (doc && needsRates([doc])) await warmRates();
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

/**
 * "Mark as ordered" (or Undo) with what the seller fills in: the DELIVERY date (when the parcel arrives; null clears it, not given keeps the one there), and
 * (when given) the buying price and the order earning of the Net Profit sheet. The mark "ELMS: ordered, delivery <date>" goes into the order's private note in
 * ELMS after the seller's own text (a new delivery date replaces the old one; Undo takes it out). A key that is not given is left alone. An order that is already
 * shipped is not turned back. @returns {Promise<{ order?: object, error?: 'not_found'|'shipped' }>}
 */
async function markOrdered(userId, id, { ordered, date, deliveryDate, buyingPrice, orderEarning } = {}) {
  const current = await Order.findOne({ _id: id, userId }).select('fulfillmentStatus sellerNote orderedAt deliveryDate').lean();
  if (!current) return { error: 'not_found' };
  if (['shipped', 'delivered'].includes(current.fulfillmentStatus)) return { error: 'shipped' };
  const validDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());
  const num = (v) => (v === null || v === '' ? null : Number(Number(v).toFixed(2)));
  const delivery = !ordered ? null : deliveryDate === undefined ? (current.deliveryDate || null) : validDate(deliveryDate) ? deliveryDate : null;
  const set = {
    fulfillmentStatus: ordered ? 'ordered_from_amazon' : 'pending',
    orderedAt: ordered ? (validDate(date) ? date : current.orderedAt || new Date()) : null,
    deliveryDate: delivery,
    sellerNote: applyMark(current.sellerNote, ordered, delivery, 2000),
  };
  if (buyingPrice !== undefined) set.sheetAmazonPrice = num(buyingPrice);
  if (orderEarning !== undefined) set.orderEarning = num(orderEarning);
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true });
  return doc ? { order: serialize(doc) } : { error: 'not_found' };
}

/** What happened to the "ordered" mark in the eBay note of an order: written (true), removed (false), or nothing changed (null); `error` says why it did not work (null = fine). */
async function setEbayNoteState(userId, id, { written = null, error = null } = {}) {
  const set = { ebayNoteError: error ? String(error).slice(0, 300) : null };
  if (written === true) set.ebayNoteAt = new Date();
  if (written === false) set.ebayNoteAt = null;
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true });
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
    ordered_at: obj.orderedAt || null,
    delivery_date: obj.deliveryDate || null,
    ebay_note_at: obj.ebayNoteAt || null,
    ebay_note_error: obj.ebayNoteError || null,
    sheet_amazon_price: obj.sheetAmazonPrice ?? null, // Net Profit sheet: typed by the seller
    order_earning: obj.orderEarning ?? null, // Net Profit sheet: typed by the seller
    net_profit_typed: obj.netProfit ?? null, // typed in the first version of the sheet
    net_profit: resolveNetProfit(obj.orderEarning, obj.sheetAmazonPrice, obj.netProfit), // order earning - Amazon price when both are typed, else the older typed figure
    order_status: deriveOrderStatus(obj),
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

// ---------------------------------------------------------------- the dashboard's order totals
const summaryCache = new Map();
const SUMMARY_TTL_MS = 60 * 1000;

/**
 * Orders, revenue and profit for the dashboard, worked out here (the dashboard used to download every order to add them up).
 * Revenue and profit are per currency (a pound and a dollar are never added), in whole cents, cancelled orders left out; the profit is the
 * same per-order profit the Orders page shows. Kept for a minute per seller.
 */
async function ordersSummary(userId, accountId = null) {
  const key = String(userId) + '|' + String(accountId || '');
  const hit = summaryCache.get(key);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const query = accountId ? { userId, ebayAccountId: accountId } : { userId };
  const docs = await Order.find(query)
    .select('userId listingId ebayAccountId sku legacyItemId quantity salePrice currency buyPriceOverride ebayCancelStatus ebayPaymentStatus fulfillmentStatus lineItemStatus ebayOrderFulfillmentStatus')
    .populate(LISTING_FOR_ORDER)
    .lean();
  await attachMissingListings(userId, docs);
  if (needsRates(docs)) await warmRates();
  const by = new Map();
  for (const doc of docs) {
    const o = enrichOrder(serialize(doc), doc);
    if (o.order_status === 'cancelled') continue;
    const cur = o.currency ? String(o.currency).toUpperCase() : null;
    if (!by.has(cur)) by.set(cur, { currency: cur, orders: 0, revenueCents: 0, profitCents: 0, profitOrders: 0 });
    const t = by.get(cur);
    t.orders += 1;
    const sale = Number(o.sale_price);
    if (o.sale_price !== null && o.sale_price !== undefined && Number.isFinite(sale)) t.revenueCents += Math.round(sale * 100 + 1e-7);
    const profit = Number(o.profit);
    if (o.profit !== null && o.profit !== undefined && Number.isFinite(profit)) { t.profitCents += Math.sign(profit) * Math.round(Math.abs(profit) * 100 + 1e-7); t.profitOrders += 1; }
  }
  const currencies = [...by.values()].sort((a, b) => b.orders - a.orders).map((t) => ({ currency: t.currency, orders: t.orders, revenue: t.revenueCents / 100, profit: t.profitOrders ? t.profitCents / 100 : null, profit_orders: t.profitOrders }));
  const value = { orders: docs.length, currencies };
  summaryCache.set(key, { at: Date.now(), value });
  if (summaryCache.size > 500) summaryCache.delete(summaryCache.keys().next().value);
  return value;
}

// ---------------------------------------------------------------- the Net Profit sheet (services/netProfitService.js)
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The orders of products listed WITH ELMS: the order is linked to an ELMS listing, or its SKU / eBay item number is one of the seller's ELMS
 * listings (the same matching the sheet uses to find an order's title and cost). Orders for things the seller listed on eBay some other way
 * are not part of the sheet.
 */
async function elmsOrdersCondition(userId) {
  const [skus, itemIds] = await Promise.all([
    Listing.distinct('sku', { userId, status: { $nin: ['draft', 'error'] } }),
    Listing.distinct('ebayListingId', { userId, ebayListingId: { $nin: [null, ''] } }),
  ]);
  const ownSkus = skus.filter((s) => s && !/^EBAY-/.test(String(s)));
  return { $or: [{ listingId: { $ne: null } }, ...(ownSkus.length ? [{ sku: { $in: ownSkus } }] : []), ...(itemIds.length ? [{ legacyItemId: { $in: itemIds.map(String) } }] : [])] };
}

/** The database filter of the sheet: only orders of ELMS listings, store, dates, a search in the title / order ID / SKU / item number, and cancelled orders (left out unless asked). */
async function netProfitQuery(userId, { accountId, from, to, q, includeCancelled } = {}) {
  const query = { userId };
  const and = [];
  if (accountId) query.ebayAccountId = accountId;
  if (!includeCancelled) query.ebayCancelStatus = { $nin: ['CANCELED', 'CANCELLED'] };
  if (from || to) {
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    and.push({ $or: [{ ebayCreatedAt: range }, { ebayCreatedAt: null, createdAt: range }] });
  }
  const text = String(q || '').trim();
  if (text) {
    const re = new RegExp(escapeRegExp(text), 'i');
    const listings = await Listing.find({ userId, title: re }).select('_id').limit(2000).lean();
    and.push({ $or: [{ itemTitle: re }, { ebayOrderId: re }, { sku: re }, { legacyItemId: re }, ...(listings.length ? [{ listingId: { $in: listings.map((l) => l._id) } }] : [])] });
  }
  and.push(await elmsOrdersCondition(userId));
  query.$and = and;
  return query;
}

/**
 * The net profit of the orders, per currency, over the same orders the sheet has (light: one database sum, no lines are read). An order's net
 * profit is ORDER EARNING - AMAZON PRICE when the seller typed both, else the figure the first version of the sheet had them type.
 * `orders` = how many orders have a net profit; `ordersTotal` = all the orders the filters give.
 */
async function netProfitSummary(userId, filters = {}) {
  const base = await netProfitQuery(userId, filters);
  const cast = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));
  const match = { ...base, userId: cast(userId) };
  if (match.ebayAccountId) match.ebayAccountId = cast(match.ebayAccountId);
  const typed = (field) => ({ $ne: [{ $ifNull: [field, null] }, null] });
  const net = { $cond: [{ $and: [typed('$orderEarning'), typed('$sheetAmazonPrice')] }, { $subtract: ['$orderEarning', '$sheetAmazonPrice'] }, { $ifNull: ['$netProfit', null] }] };
  const [rows, ordersTotal] = await Promise.all([
    Order.aggregate([
      { $match: match },
      { $addFields: { _net: net } },
      { $match: { _net: { $ne: null } } },
      { $group: { _id: '$currency', sum: { $sum: { $round: [{ $multiply: ['$_net', 100] }, 0] } }, count: { $sum: 1 } } },
    ]),
    Order.countDocuments(base),
  ]);
  const currencies = rows.map((r) => ({ currency: r._id ? String(r._id).toUpperCase() : null, net_profit: Math.round(r.sum) / 100, orders: r.count })).sort((a, b) => b.orders - a.orders);
  return { currencies, orders: currencies.reduce((n, c) => n + c.orders, 0), ordersTotal };
}

async function countNetProfitLines(userId, filters) {
  return Order.countDocuments(await netProfitQuery(userId, filters));
}

/** Lines of the sheet, newest first: `limit` of them from `offset`. */
async function listNetProfitLines(userId, filters, { offset = 0, limit = 1000 } = {}) {
  const docs = await Order.find(await netProfitQuery(userId, filters))
    .populate(LISTING_FOR_ORDER)
    .populate(ACCOUNT_FOR_ORDER)
    .sort({ ebayCreatedAt: -1, createdAt: -1, _id: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  await attachMissingListings(userId, docs);
  return docs.map((doc) => buildNetProfitLine(enrichOrder(serialize(doc), doc)));
}

async function getNetProfitLine(userId, id) {
  const doc = await Order.findOne({ _id: id, userId }).populate(LISTING_FOR_ORDER).populate(ACCOUNT_FOR_ORDER).lean();
  if (!doc) return null;
  await attachMissingListings(userId, [doc]);
  return buildNetProfitLine(enrichOrder(serialize(doc), doc));
}

/**
 * Saves the figures the seller typed on the sheet: the Amazon price and the order earning of an order (and, for an older client, the net
 * profit). A key that is not given is left alone; null / '' clears it. Returns false when the order is not theirs.
 */
async function setSheetInputs(userId, id, { amazonPrice, orderEarning, netProfit } = {}) {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(Number(v).toFixed(2)));
  const set = {};
  if (amazonPrice !== undefined) set.sheetAmazonPrice = num(amazonPrice);
  if (orderEarning !== undefined) set.orderEarning = num(orderEarning);
  if (netProfit !== undefined) set.netProfit = num(netProfit);
  if (!Object.keys(set).length) return false;
  const doc = await Order.findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true });
  return !!doc;
}

/**
 * Every order line still waiting for its eBay-fetched earning (services/ebayFinancesService.js) - fully paid (never a
 * partial/refunded one, v1 does not net out refunds), and paid at least minAgeMs ago so eBay has had time to settle the
 * sale into a Finances transaction before the first attempt. Grouped by ebayOrderId by the caller, since eBay's fee data
 * is per ORDER, not per line item, and one eBay order can be several of these rows (one per SKU).
 */
async function listOrdersNeedingEarnings(ebayAccountId, minAgeMs) {
  const cutoff = new Date(Date.now() - minAgeMs);
  return Order.find({
    ebayAccountId,
    orderEarning: null,
    ebayPaymentStatus: 'FULLY_PAID',
    ebayOrderId: { $ne: null },
    paidAt: { $ne: null, $lt: cutoff },
  }).select('_id ebayOrderId salePrice').lean();
}

/** Saves the eBay-fetched earning on several order lines at once (one write per distinct value, via bulkWrite). */
async function setOrderEarningsBulk(updates) {
  const ops = updates
    .filter((u) => u && u.id && Number.isFinite(Number(u.orderEarning)))
    .map((u) => ({ updateOne: { filter: { _id: u.id, orderEarning: null }, update: { $set: { orderEarning: Number(u.orderEarning.toFixed(2)) } } } }));
  if (!ops.length) return 0;
  const result = await Order.bulkWrite(ops);
  return result.modifiedCount || 0;
}

module.exports = { listOrders, getOrderById, updateFulfillmentStatus, upsertOrder, setTracking, linkAmazonOrder, setSellerNote, setEbayNoteState, markOrdered, setBuyPrice, linkOrderToListing, deriveOrderStatus, netProfitQuery, countNetProfitLines, listNetProfitLines, getNetProfitLine, setSheetInputs, netProfitSummary, ordersSummary, listOrdersNeedingEarnings, setOrderEarningsBulk, _summaryCache: summaryCache };
