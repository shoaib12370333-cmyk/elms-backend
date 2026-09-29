const mongoose = require('mongoose');
const SupplierOrder = require('./schemas/SupplierOrder');

/** Snapshot fields no longer needed once an order can't move forward on its own any more (services/autoOrderService.js
 * README above SupplierOrder explains why needs_attention keeps its address - it can still be retried). */
const TERMINAL_STATUSES = ['placed', 'failed', 'cancelled'];

function serialize(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id.toString(),
    ebay_account_id: obj.ebayAccountId ? obj.ebayAccountId.toString() : null,
    order_id: obj.orderId ? obj.orderId.toString() : null,
    listing_id: obj.listingId ? obj.listingId.toString() : null,
    ebay_order_id: obj.ebayOrderId,
    ebay_line_item_id: obj.ebayLineItemId,
    legacy_item_id: obj.legacyItemId,
    source_platform: obj.sourcePlatform,
    asin: obj.asin,
    variant_details: obj.variantDetails,
    quantity: obj.quantity,
    shipping_address: obj.shippingAddress || null,
    max_allowed_cost: obj.maxAllowedCost,
    status: obj.status,
    amazon_order_id: obj.amazonOrderId,
    amazon_total: obj.amazonTotal,
    fulfillment_method: obj.fulfillmentMethod,
    error: obj.error,
    placed_at: obj.placedAt,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

/** Creates a supplier order for one eBay line item. Silently returns null on a duplicate (the unique ebayLineItemId index
 * already did its job - a re-sync of the same paid order must never place a second Amazon order), and rethrows any other
 * error since that would mean something is actually wrong. */
async function createSupplierOrder(data) {
  try {
    const doc = await SupplierOrder.create(data);
    return serialize(doc);
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}

async function getSupplierOrderById(userId, id) {
  const doc = await SupplierOrder.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

async function listSupplierOrders(userId, { status } = {}) {
  const query = { userId };
  if (status) query.status = Array.isArray(status) ? { $in: status } : status;
  const docs = await SupplierOrder.find(query).sort({ createdAt: -1 }).lean();
  return docs.map(serialize);
}

/** Atomically claims the oldest 'ready' order for this user, moving it straight to 'checking' so two nearly-simultaneous
 * polls (or two devices running the extension) never claim the same order. Returns null when there is nothing ready. */
async function claimNextReadyOrder(userId) {
  const doc = await SupplierOrder.findOneAndUpdate(
    { userId, status: 'ready' },
    { status: 'checking' },
    { sort: { createdAt: 1 }, new: true }
  );
  return doc ? serialize(doc) : null;
}

/** The extension confirms all of its own checks passed and it is about to click "Place your order". Only allowed from
 * 'checking' - a stray call for an order it never claimed (or already moved on) is refused. */
async function markPlacing(userId, id) {
  const doc = await SupplierOrder.findOneAndUpdate(
    { _id: id, userId, status: 'checking' },
    { status: 'placing' },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** The order was actually placed on Amazon. Clears the buyer's address (no longer needed) and records when. */
async function markPlaced(userId, id, { amazonOrderId, amazonTotal }) {
  const value = String(amazonOrderId || '').trim();
  if (!value) throw new Error('An Amazon order ID is required.');
  const doc = await SupplierOrder.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['checking', 'placing'] } },
    {
      status: 'placed',
      amazonOrderId: value,
      amazonTotal: Number.isFinite(Number(amazonTotal)) ? Number(amazonTotal) : null,
      placedAt: new Date(),
      shippingAddress: null,
    },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** A known, human-fixable block (captcha, sign-in/2FA, price rose past maxAllowedCost, out of stock, a spending limit) -
 * the extension must never retry these on its own. The address is kept: a human can fix the block and retry. */
async function markNeedsAttention(userId, id, reason) {
  const doc = await SupplierOrder.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['checking', 'placing'] } },
    { status: 'needs_attention', error: reason ? String(reason).slice(0, 500) : null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** An unexpected error (not one of the known needs_attention reasons). Clears the address like any other terminal state. */
async function markFailed(userId, id, reason) {
  const doc = await SupplierOrder.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['checking', 'placing'] } },
    { status: 'failed', error: reason ? String(reason).slice(0, 500) : null, shippingAddress: null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** A needs_attention (or failed) order the seller wants the extension to try again - back to 'ready', with a fresh
 * address snapshot supplied by the caller (services/autoOrderService.js re-reads it from the linked Order, since a
 * failed/needs_attention transition may have already cleared it). */
async function retrySupplierOrder(userId, id, { shippingAddress } = {}) {
  const doc = await SupplierOrder.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['needs_attention', 'failed'] } },
    { status: 'ready', error: null, ...(shippingAddress ? { shippingAddress } : {}) },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function markCreditCharged(id) {
  await SupplierOrder.updateOne({ _id: id }, { creditCharged: true });
}

/** How much has already been placed today (UTC) for this user - services/autoOrderService.js checks this against
 * autoOrderDailyLimit before handing out a new ready order. */
async function todaysPlacedTotal(userId) {
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  // Aggregation pipelines skip Mongoose's usual string->ObjectId casting, so userId must be cast by hand here.
  const rows = await SupplierOrder.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), status: 'placed', placedAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$amazonTotal' } } },
  ]);
  return rows[0]?.total || 0;
}

module.exports = {
  TERMINAL_STATUSES,
  createSupplierOrder,
  getSupplierOrderById,
  listSupplierOrders,
  claimNextReadyOrder,
  markPlacing,
  markPlaced,
  markNeedsAttention,
  markFailed,
  retrySupplierOrder,
  markCreditCharged,
  todaysPlacedTotal,
  serialize,
};
