const express = require('express');
const router = express.Router();
const { listOrders, updateFulfillmentStatus, upsertOrder } = require('../models/ordersModel');
const { getEbayRefreshToken } = require('../models/usersModel');
const { fetchOrders, normalizeOrderLineItems } = require('../services/ebayOrdersService');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/orders
 * Requires a valid session token.
 * Returns the current user's orders (joined with their listing's title/image).
 */
router.get('/', requireAuth, async (req, res) => {
  const orders = await listOrders(req.userId);
  res.json({ success: true, orders });
});

/**
 * POST /api/orders/sync
 * Requires a valid session token and a connected eBay account.
 *
 * Pulls recent orders from eBay's Fulfillment API and saves any new ones -
 * safe to call repeatedly, since existing orders are matched and updated
 * rather than duplicated (see models/ordersModel.upsertOrder).
 */
router.post('/sync', requireAuth, async (req, res) => {
  const refreshToken = await getEbayRefreshToken(req.userId);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  }

  try {
    const rawOrders = await fetchOrders(refreshToken);

    let savedCount = 0;
    for (const rawOrder of rawOrders) {
      const lineItems = normalizeOrderLineItems(rawOrder);
      for (const lineItem of lineItems) {
        await upsertOrder(req.userId, lineItem);
        savedCount++;
      }
    }

    const orders = await listOrders(req.userId);
    res.json({ success: true, syncedCount: savedCount, orders });
  } catch (err) {
    console.error('order sync error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not sync orders from eBay.',
    });
  }
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

module.exports = router;
