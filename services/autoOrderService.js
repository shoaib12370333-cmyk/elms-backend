const User = require('./../models/schemas/User');
const Import = require('../models/schemas/Import');
const Listing = require('../models/schemas/Listing');
const { createSupplierOrder, markPlaced, todaysPlacedTotal, startPendingSupplierOrders } = require('../models/supplierOrdersModel');
const { linkAmazonOrder, markOrdered, getOrderById } = require('../models/ordersModel');
const { getEbayAccountById, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { writeAmazonOrderNote } = require('./ebayOrderNoteService');
const { hasCredits, spendCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * The Orders page's own "Send to Auto Order" bulk action - the seller explicitly picking ONE paid eBay order to
 * queue for Auto Order. There is no automatic-on-payment creation any more: the seller decides which orders enter
 * Auto Order at all, not just when the queue starts (see startQueuedSupplierOrders, below). Creates the supplier
 * order as 'pending' (queued, not yet eligible for the extension's poll - claimNextReadyOrder only ever claims
 * 'ready') when, and only when, every one of these holds:
 *   - the order exists and belongs to this seller,
 *   - the eBay order line is actually paid,
 *   - the line item has an ebayLineItemId to key the (unique-indexed) supplier order on,
 *   - it is linked to a listing that is an Amazon listing (sourcePlatform 'amazon') - never CJ or AliExpress, which
 *     use their own supplier APIs instead of a buyer-account browser extension,
 *   - the seller has Auto Order switched to 'full_auto'.
 * Never throws: one bad order in a bulk selection must never take down the rest of that request.
 * @returns {Promise<{status: 'queued', supplierOrder: object} | {status: 'skipped', reason: string}>}
 */
async function queueSupplierOrder(userId, orderId) {
  const skip = (reason) => ({ status: 'skipped', reason });
  try {
    const order = await getOrderById(userId, orderId);
    if (!order) return skip('Order not found.');
    if (String(order.ebay_payment_status || '').toUpperCase() !== 'PAID') return skip('This order is not paid yet.');
    if (!order.ebay_line_item_id) return skip('This order has no eBay line item to key on.');
    if (!order.listing_id) return skip('This order is not linked to one of your listings.');

    const listing = await Listing.findOne({ _id: order.listing_id, userId }).select('sourcePlatform amazonPrice importId sku').lean();
    if (!listing || listing.sourcePlatform !== 'amazon') return skip('Only Amazon-sourced listings can be sent to Auto Order.');

    const user = await User.findById(userId).select('autoOrderMode autoOrderMaxPriceIncreasePercent autoOrderMaxCost').lean();
    if (!user || user.autoOrderMode !== 'full_auto') return skip('Auto Order is not switched to Full-auto in Settings.');

    const basePrice = Number(listing.amazonPrice);
    const pctCap = Number.isFinite(basePrice) && basePrice > 0
      ? basePrice * (1 + (Number(user.autoOrderMaxPriceIncreasePercent) || 0) / 100)
      : null;
    const hardCap = Number.isFinite(Number(user.autoOrderMaxCost)) ? Number(user.autoOrderMaxCost) : null;
    const caps = [pctCap, hardCap].filter((n) => Number.isFinite(n) && n > 0);
    const maxAllowedCost = caps.length ? Math.min(...caps) : null;

    // The listing's own import record has the exact product page it was read from.
    const amazonUrl = listing.importId
      ? (await Import.findById(listing.importId).select('amazonUrl').lean())?.amazonUrl || null
      : null;

    const created = await createSupplierOrder({
      userId,
      ebayAccountId: order.ebay_account_id || null,
      orderId: order.id,
      listingId: listing._id,
      ebayOrderId: order.ebay_order_id,
      ebayLineItemId: order.ebay_line_item_id,
      legacyItemId: order.legacy_item_id || null,
      sourcePlatform: 'amazon',
      asin: listing.sku,
      amazonUrl,
      variantDetails: order.variant_details || null,
      quantity: order.quantity || 1,
      // Amazon needs a phone number to save a new address; eBay's own buyer phone (a separate field on Order, not
      // part of its shippingAddress) is folded in here so the extension has everything in one place.
      shippingAddress: order.shipping_address ? { ...order.shipping_address, phone: order.buyer_phone || null } : null,
      maxAllowedCost,
      status: 'pending',
      fulfillmentMethod: 'extension',
    });
    if (!created) return skip('This order was already sent to Auto Order.');
    return { status: 'queued', supplierOrder: created };
  } catch (err) {
    console.error('[auto-order] could not queue a supplier order:', err.message);
    return skip(err.message || 'Could not queue this order.');
  }
}

/**
 * The Orders page's own "Start Auto Order" button - promotes every one of this seller's queued ('pending') supplier
 * orders to 'ready' in one shot, so the extension's normal poll picks them up from there, one at a time, exactly as
 * before. A one-time promotion, not a standing mode: anything queued afterward needs its own Start.
 * @returns {Promise<number>} how many were actually promoted
 */
async function startQueuedSupplierOrders(userId) {
  return startPendingSupplierOrders(userId);
}

/**
 * Whether this user's daily Auto Order spending limit (models/schemas/User.js autoOrderDailyLimit) still has room for
 * one more order of about this size. No limit set at all always passes.
 */
async function withinDailyLimit(userId, estimatedCost) {
  const user = await User.findById(userId).select('autoOrderDailyLimit').lean();
  const limit = Number(user?.autoOrderDailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const spent = await todaysPlacedTotal(userId);
  return spent + (Number(estimatedCost) || 0) <= limit;
}

/**
 * The extension reported a successful placement. In order:
 *   1. mark the supplier order 'placed' (models/supplierOrdersModel.js already clears its stored address),
 *   2. link the Amazon order ID onto the ELMS order the seller already sees on the Orders page, and - the same as
 *      the manual "Mark as ordered" dialog - save the delivery date the extension read and the buying price (the
 *      real Amazon total) onto the Net Profit sheet, so nothing needs typing in by hand afterwards,
 *   3. best-effort write "Amazon order <id>" into the eBay order's own private note,
 *   4. charge ACTION_COSTS.AUTO_ORDER - best effort: the Amazon purchase already happened for real, so a missing
 *      ELMS credit never undoes it, it is just logged for support to reconcile by hand.
 * @returns {Promise<object|null>} the updated supplier order, or null if it was not in a state this could apply to
 */
async function completeSupplierOrderPlacement(userId, supplierOrderId, { amazonOrderId, amazonTotal, deliveryDate }) {
  const updated = await markPlaced(userId, supplierOrderId, { amazonOrderId, amazonTotal });
  if (!updated) return null;

  if (updated.order_id) {
    await linkAmazonOrder(userId, updated.order_id, amazonOrderId, 'ordered_from_amazon').catch((err) => {
      console.error('[auto-order] could not link the Amazon order id to the ELMS order:', err.message);
    });
    const parsedDelivery = deliveryDate ? new Date(deliveryDate) : undefined;
    await markOrdered(userId, updated.order_id, {
      ordered: true,
      date: new Date(),
      deliveryDate: parsedDelivery && !Number.isNaN(parsedDelivery.getTime()) ? parsedDelivery : undefined,
      buyingPrice: amazonTotal ?? undefined,
    }).catch((err) => {
      console.error('[auto-order] could not save the delivery date / buying cost on the ELMS order:', err.message);
    });
  }

  if (updated.ebay_account_id && updated.ebay_order_id) {
    try {
      const account = await getEbayAccountById(userId, updated.ebay_account_id);
      const refreshToken = await getEbayAccountRefreshToken(userId, updated.ebay_account_id);
      if (account && refreshToken) {
        await writeAmazonOrderNote(refreshToken, account.marketplaceId || 'EBAY_US', {
          orderId: updated.ebay_order_id,
          itemId: updated.legacy_item_id,
          amazonOrderId,
        });
      }
    } catch (err) {
      console.error('[auto-order] could not write the eBay order note:', err.message);
    }
  }

  const charged = await spendCredit(userId, ACTION_COSTS.AUTO_ORDER).catch(() => false);
  if (!charged) console.error(`[auto-order] could not charge AUTO_ORDER credit for user ${userId}, supplier order ${supplierOrderId} - insufficient balance or a transient error.`);

  return updated;
}

/** Whether the extension should refuse anything not sold/fulfilled by Amazon itself (models/schemas/User.js
 * autoOrderPrimeOnly, on by default) - sent alongside the order in GET /api/auto-order/next so the extension doesn't
 * need a second request just to read one setting. */
async function primeOnlySetting(userId) {
  const user = await User.findById(userId).select('autoOrderPrimeOnly').lean();
  return user ? user.autoOrderPrimeOnly !== false : true;
}

module.exports = { queueSupplierOrder, startQueuedSupplierOrders, withinDailyLimit, completeSupplierOrderPlacement, hasCredits, primeOnlySetting };
