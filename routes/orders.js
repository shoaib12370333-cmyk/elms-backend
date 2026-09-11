const express = require('express');
const router = express.Router();
const { listOrders, updateFulfillmentStatus, upsertOrder, getOrderById, setTracking } = require('../models/ordersModel');
const { listEbayAccounts, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { fetchOrders, normalizeOrderLineItems, createShippingFulfillment } = require('../services/ebayOrdersService');
const { convertTracking } = require('../services/trackingConversionService');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/orders?accountId=...
 * Requires a valid session token.
 * Returns the current user's orders across ALL of their connected eBay
 * accounts by default (a combined view), or filtered to one account if
 * accountId is given.
 */
router.get('/', requireAuth, async (req, res) => {
  const orders = await listOrders(req.userId, req.query.accountId);
  res.json({ success: true, orders });
});

/**
 * POST /api/orders/sync
 * Requires a valid session token and at least one connected eBay account.
 *
 * Pulls recent orders from eBay's Fulfillment API for EVERY one of the
 * user's connected eBay accounts (not just one), and saves any new ones -
 * safe to call repeatedly, since existing orders are matched and updated
 * rather than duplicated (see models/ordersModel.upsertOrder).
 */
router.post('/sync', requireAuth, async (req, res) => {
  const accounts = await listEbayAccounts(req.userId);
  if (!accounts.length) {
    return res.status(400).json({ success: false, error: 'Please connect an eBay account first.' });
  }

  let savedCount = 0;
  const errors = [];

  for (const account of accounts) {
    try {
      const refreshToken = await getEbayAccountRefreshToken(req.userId, account.id);
      if (!refreshToken) continue;

      const rawOrders = await fetchOrders(refreshToken);

      for (const rawOrder of rawOrders) {
        const lineItems = normalizeOrderLineItems(rawOrder);
        for (const lineItem of lineItems) {
          await upsertOrder(req.userId, lineItem, account.id);
          savedCount++;
        }
      }
    } catch (err) {
      console.error(`order sync error for account ${account.ebayUserId}:`, err.message);
      errors.push(`${account.ebayUserId}: ${err.message}`);
    }
  }

  const orders = await listOrders(req.userId, req.query.accountId);
  res.json({ success: true, syncedCount: savedCount, orders, errors: errors.length ? errors : undefined });
});

/**
 * PUT /api/orders/:id
 * Requires a valid session token.
 * Body: { fulfillmentStatus: string, amazonOrderId?: string }
 *
 * Updates an order's fulfillment status. Only works on orders owned by
 * the current user.
 */
router.put('/:id', requireAuth, async (req, res) => {
  const { fulfillmentStatus, amazonOrderId } = req.body;

  if (!fulfillmentStatus) {
    return res.status(400).json({ success: false, error: 'A fulfillmentStatus is required.' });
  }

  const updated = await updateFulfillmentStatus(req.userId, req.params.id, fulfillmentStatus, amazonOrderId);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  res.json({ success: true, order: updated });
});

/**
 * PUT /api/orders/:id/tracking
 * Requires a valid session token.
 * Body: { trackingNumber: string, shippingCarrier?: string }
 *
 * Saves a tracking number for an order and notifies eBay (so the buyer
 * sees it too), marking the order as shipped.
 */
router.post('/tracking/convert', requireAuth, async (req, res) => {
  try {
    const converted = convertTracking({
      trackingNumber: req.body?.trackingNumber,
      carrier: req.body?.carrier || req.body?.shippingCarrier,
    });
    res.json({ success: true, conversion: converted });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.put('/:id/tracking', requireAuth, async (req, res) => {
  const { trackingNumber, shippingCarrier, carrier } = req.body;
  const sourceCarrier = shippingCarrier || carrier;

  if (!trackingNumber) {
    return res.status(400).json({ success: false, error: 'A trackingNumber is required.' });
  }

  const converted = convertTracking({ trackingNumber, carrier: sourceCarrier });
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  // Try to notify eBay too, so the buyer can see the tracking info on
  // their end - but don't block saving it locally if that call fails
  // (e.g. missing eBay account access), since the seller still needs the
  // number recorded either way.
  if (order.ebay_order_id && order.ebay_line_item_id && order.ebay_account_id) {
    try {
      const refreshToken = await getEbayAccountRefreshToken(req.userId, order.ebay_account_id);

      if (refreshToken) {
        await createShippingFulfillment(
          refreshToken,
          order.ebay_order_id,
          order.ebay_line_item_id,
          order.quantity,
          converted.trackingNumber,
          converted.shippingCarrierCode
        );
      }
    } catch (err) {
      console.warn('Could not notify eBay of tracking number:', err.message);
    }
  }

  const updated = await setTracking(req.userId, req.params.id, converted.trackingNumber, converted.shippingCarrierCode);
  res.json({ success: true, order: updated, trackingConversion: converted });
});

module.exports = router;
