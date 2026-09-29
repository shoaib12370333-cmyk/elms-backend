const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  getSupplierOrderById,
  listSupplierOrders,
  claimNextReadyOrder,
  markPlacing,
  markNeedsAttention,
  markFailed,
  retrySupplierOrder,
} = require('../models/supplierOrdersModel');
const { getOrderById } = require('../models/ordersModel');
const { completeSupplierOrderPlacement, withinDailyLimit, hasCredits, primeOnlySetting } = require('../services/autoOrderService');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * Every route here is called by the Auto Order browser extension, authenticated the same way the ELMS web app is: the
 * extension exchanges the user's extension key for a normal session token (POST /api/auth/extension-key/exchange) once,
 * then sends that token like any other signed-in request - no separate auth system needed for this extension either.
 */

/**
 * GET /api/auto-order/next
 * The next ready order for this user, or { order: null } when there is nothing to do right now (not switching this
 * listing/order to an error state - "nothing ready" is the normal, most-of-the-time answer, not a failure).
 * Claims it (ready -> checking) so two polls (or two devices) never grab the same order.
 */
router.get('/next', requireAuth, async (req, res) => {
  // Never hand out a new order once the user is out of credits (real Amazon money would be spent for an action ELMS
  // could not then charge for) or has already reached today's spending limit.
  if (!(await hasCredits(req.userId, ACTION_COSTS.AUTO_ORDER))) return res.json({ success: true, order: null, reason: 'out_of_credits' });

  const order = await claimNextReadyOrder(req.userId);
  if (!order) return res.json({ success: true, order: null });

  if (order.max_allowed_cost != null && !(await withinDailyLimit(req.userId, order.max_allowed_cost))) {
    await markNeedsAttention(req.userId, order.id, "Today's Auto Order spending limit has been reached.");
    return res.json({ success: true, order: null, reason: 'daily_limit' });
  }

  // Sent alongside the order rather than making the extension fetch seller settings separately just for this one flag.
  res.json({ success: true, order, settings: { primeOnly: await primeOnlySetting(req.userId) } });
});

/**
 * POST /api/auto-order/:id/placing
 * The extension's own checks (stock, fulfillment, price, spending limit) all passed and it is about to click
 * "Place your order". Refused (404) if this order was not claimed by this user, or is not in 'checking'.
 */
router.post('/:id/placing', requireAuth, async (req, res) => {
  const order = await markPlacing(req.userId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'That supplier order was not found, or is not ready to be placed.' });
  res.json({ success: true, order });
});

/**
 * POST /api/auto-order/:id/placed
 * Body: { amazonOrderId, amazonTotal }
 * The order was actually placed on Amazon. Links the Amazon order ID onto the ELMS order, writes the eBay note, and
 * charges the AUTO_ORDER credit - see services/autoOrderService.js completeSupplierOrderPlacement.
 */
router.post('/:id/placed', requireAuth, async (req, res) => {
  const { amazonOrderId, amazonTotal } = req.body || {};
  if (!amazonOrderId) return res.status(400).json({ success: false, error: 'An Amazon order ID is required.' });
  try {
    const order = await completeSupplierOrderPlacement(req.userId, req.params.id, { amazonOrderId, amazonTotal });
    if (!order) return res.status(404).json({ success: false, error: 'That supplier order was not found, or was not awaiting placement.' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auto-order/:id/failed
 * Body: { reason, needsAttention?: boolean }
 * needsAttention (default true): a known, human-fixable block (captcha, sign-in/2FA, the price rose, out of stock, a
 * changed/unknown page) - the extension must never retry these by itself. needsAttention: false is for a genuinely
 * unexpected error instead.
 */
router.post('/:id/failed', requireAuth, async (req, res) => {
  const { reason, needsAttention } = req.body || {};
  const order = needsAttention === false
    ? await markFailed(req.userId, req.params.id, reason)
    : await markNeedsAttention(req.userId, req.params.id, reason);
  if (!order) return res.status(404).json({ success: false, error: 'That supplier order was not found, or was not awaiting placement.' });
  res.json({ success: true, order });
});

/**
 * GET /api/auto-order?status=needs_attention
 * Lists this user's supplier orders (all of them, or filtered to one status) for the Orders page.
 */
router.get('/', requireAuth, async (req, res) => {
  const orders = await listSupplierOrders(req.userId, { status: req.query.status || undefined });
  res.json({ success: true, orders });
});

/**
 * POST /api/auto-order/:id/retry
 * The seller fixed whatever needs_attention (or failed) flagged and wants the extension to try this order again.
 * Re-reads the buyer's address from the linked ELMS order, since a terminal state may have cleared it.
 */
router.post('/:id/retry', requireAuth, async (req, res) => {
  const current = await getSupplierOrderById(req.userId, req.params.id);
  if (!current) return res.status(404).json({ success: false, error: 'That supplier order was not found.' });

  let shippingAddress;
  if (current.order_id) {
    const order = await getOrderById(req.userId, current.order_id);
    shippingAddress = order?.shipping_address || undefined;
  }

  const order = await retrySupplierOrder(req.userId, req.params.id, { shippingAddress });
  if (!order) return res.status(400).json({ success: false, error: 'This order is not in a state that can be retried.' });
  res.json({ success: true, order });
});

module.exports = router;
