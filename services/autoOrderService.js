const User = require('./../models/schemas/User');
const { createSupplierOrder, markPlaced, todaysPlacedTotal } = require('../models/supplierOrdersModel');
const { linkAmazonOrder } = require('../models/ordersModel');
const { getEbayAccountById, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { writeAmazonOrderNote } = require('./ebayOrderNoteService');
const { hasCredits, spendCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * Called from models/ordersModel.js upsertOrder for every order line that is genuinely new or has just turned into
 * a paid one. Creates the matching supplier order when, and only when, every one of these holds:
 *   - the listing exists and is an Amazon listing (sourcePlatform 'amazon') - never CJ or AliExpress, which use their
 *     own supplier APIs instead of a buyer-account browser extension,
 *   - the eBay order line is actually paid,
 *   - the line item has an ebayLineItemId to key the (unique-indexed) supplier order on,
 *   - the seller has Auto Order switched to 'full_auto'.
 * Never throws: a problem here must never break order sync itself. Returns the created supplier order, or null when
 * any condition above was not met (including the ordinary case of a duplicate line item already handled).
 */
async function maybeCreateSupplierOrder({ userId, listing, order, ebayAccountId }) {
  try {
    if (!listing || listing.sourcePlatform !== 'amazon') return null;
    if (String(order.ebayPaymentStatus || '').toUpperCase() !== 'PAID') return null;
    if (!order.ebayLineItemId) return null;

    const user = await User.findById(userId)
      .select('autoOrderMode autoOrderMaxPriceIncreasePercent autoOrderMaxCost')
      .lean();
    if (!user || user.autoOrderMode !== 'full_auto') return null;

    const basePrice = Number(listing.amazonPrice);
    const pctCap = Number.isFinite(basePrice) && basePrice > 0
      ? basePrice * (1 + (Number(user.autoOrderMaxPriceIncreasePercent) || 0) / 100)
      : null;
    const hardCap = Number.isFinite(Number(user.autoOrderMaxCost)) ? Number(user.autoOrderMaxCost) : null;
    const caps = [pctCap, hardCap].filter((n) => Number.isFinite(n) && n > 0);
    const maxAllowedCost = caps.length ? Math.min(...caps) : null;

    return await createSupplierOrder({
      userId,
      ebayAccountId: ebayAccountId || null,
      orderId: order._id,
      listingId: listing._id,
      ebayOrderId: order.ebayOrderId,
      ebayLineItemId: order.ebayLineItemId,
      legacyItemId: order.legacyItemId || null,
      sourcePlatform: 'amazon',
      asin: listing.sku,
      variantDetails: order.variantDetails || null,
      quantity: order.quantity || 1,
      shippingAddress: order.shippingAddress || null,
      maxAllowedCost,
      status: 'ready',
      fulfillmentMethod: 'extension',
    });
  } catch (err) {
    console.error('[auto-order] could not create a supplier order:', err.message);
    return null;
  }
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
 *   2. link the Amazon order ID onto the ELMS order the seller already sees on the Orders page,
 *   3. best-effort write "Amazon order <id>" into the eBay order's own private note,
 *   4. charge ACTION_COSTS.AUTO_ORDER - best effort: the Amazon purchase already happened for real, so a missing
 *      ELMS credit never undoes it, it is just logged for support to reconcile by hand.
 * @returns {Promise<object|null>} the updated supplier order, or null if it was not in a state this could apply to
 */
async function completeSupplierOrderPlacement(userId, supplierOrderId, { amazonOrderId, amazonTotal }) {
  const updated = await markPlaced(userId, supplierOrderId, { amazonOrderId, amazonTotal });
  if (!updated) return null;

  if (updated.order_id) {
    await linkAmazonOrder(userId, updated.order_id, amazonOrderId, 'ordered_from_amazon').catch((err) => {
      console.error('[auto-order] could not link the Amazon order id to the ELMS order:', err.message);
    });
  }

  if (updated.ebay_account_id && updated.ebay_order_id) {
    try {
      const account = await getEbayAccountById(userId, updated.ebay_account_id);
      const refreshToken = await getEbayAccountRefreshToken(userId, updated.ebay_account_id);
      if (account && refreshToken) {
        await writeAmazonOrderNote(refreshToken, account.marketplace_id || 'EBAY_US', {
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

module.exports = { maybeCreateSupplierOrder, withinDailyLimit, completeSupplierOrderPlacement, hasCredits };
