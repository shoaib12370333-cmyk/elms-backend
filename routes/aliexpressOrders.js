const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const service = require('../services/aliexpressOrderService');

/**
 * Buying an eBay order's item from AliExpress (services/aliexpressOrderService.js). Three separate, confirmed steps - preview, place
 * (unpaid), pay - and a read-back. Nothing here is automatic and nothing is sent to eBay or the buyer.
 */

const isId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ''));
const STATUS = { not_found: 404, blocked: 409, claimed: 409, refused: 422, unknown: 502, confirm: 400, not_placed: 409, no_amount: 409, amount_changed: 409, not_accepted: 422, release_blocked: 409, multiple: 409, cancelled: 409, not_paid: 409, shipped: 409, not_payable: 409, wrong_item: 409, changed: 409, pay_unclear: 502 };

/** The reply for a service answer that is an error; the seller reads `error` (a sentence), the app switches on `code`. */
function fail(res, out) {
  const status = STATUS[out.error] || 500;
  return res.status(status).json({ success: false, error: out.message || 'Could not do that.', code: out.error, blockers: out.blockers, preview: out.preview, amount: out.amount, currency: out.currency });
}

const guard = (handler) => async (req, res) => {
  if (!isId(req.params.orderId)) return res.status(404).json({ success: false, error: 'Order not found.', code: 'not_found' });
  try {
    await handler(req, res);
  } catch (err) {
    console.error('aliexpress order error:', err.message);
    // A failure AFTER the order / payment was sent to AliExpress (saving it failed) says exactly that - never "nothing happened".
    if (err && err.irreversible) return res.status(500).json({ success: false, error: err.message, code: 'saved_late' });
    res.status(500).json({ success: false, error: 'Something went wrong. Nothing was changed on AliExpress unless it says so - check your AliExpress orders before trying again.', code: 'server' });
  }
};

/** POST /api/aliexpress-orders/:orderId/preview  { address? } - read-only: what would be ordered, what it costs, why it may not be placed. */
router.post('/:orderId/preview', requireAuth, guard(async (req, res) => {
  const out = await service.previewOrder(req.userId, req.params.orderId, { address: req.body && req.body.address });
  if (out.error) return fail(res, { ...out, message: 'Order not found.' });
  res.json({ success: true, preview: out });
}));

/** POST /api/aliexpress-orders/:orderId/place  { address?, allowLoss?, confirmNotPlaced?, shownCodes? } - creates the AliExpress order, UNPAID. shownCodes = the blockers the seller was shown and ticked: a switch only accepts those. */
router.post('/:orderId/place', requireAuth, guard(async (req, res) => {
  const body = req.body || {};
  const out = await service.placeOrder(req.userId, req.params.orderId, { address: body.address, allowLoss: body.allowLoss === true, confirmNotPlaced: body.confirmNotPlaced === true, shownCodes: Array.isArray(body.shownCodes) ? body.shownCodes.filter((c) => typeof c === 'string') : [] });
  if (out.error === 'not_found') return fail(res, { ...out, message: 'Order not found.' });
  if (out.error) return fail(res, out);
  res.json({ success: true, order: out.order, preview: out.preview });
}));

/** POST /api/aliexpress-orders/:orderId/pay  { confirm: true, expectedAmount, expectedCurrency } - pays the order, only for the amount (and currency) the seller saw. */
router.post('/:orderId/pay', requireAuth, guard(async (req, res) => {
  const body = req.body || {};
  const out = await service.payOrder(req.userId, req.params.orderId, { confirm: body.confirm === true, expectedAmount: body.expectedAmount, expectedCurrency: body.expectedCurrency });
  if (out.error === 'not_found') return fail(res, { ...out, message: 'Order not found.' });
  if (out.error) return fail(res, out);
  res.json({ success: true, order: out.order, alreadyPaid: !!out.alreadyPaid, pending: !!out.pending, message: out.message || null });
}));

/** POST /api/aliexpress-orders/:orderId/release  { confirm: true } - frees the line of an AliExpress order that AliExpress itself shows as closed / cancelled / finished with no parcel, so a new one can be placed. */
router.post('/:orderId/release', requireAuth, guard(async (req, res) => {
  const body = req.body || {};
  const out = await service.releaseOrder(req.userId, req.params.orderId, { confirm: body.confirm === true });
  if (out.error === 'not_found') return fail(res, { ...out, message: 'Order not found.' });
  if (out.error) return fail(res, out);
  res.json({ success: true, order: out.order });
}));

/** POST /api/aliexpress-orders/:orderId/refresh - reads the status, total and shipment back from AliExpress. */
router.post('/:orderId/refresh', requireAuth, guard(async (req, res) => {
  const out = await service.refreshOrder(req.userId, req.params.orderId);
  if (out.error === 'not_found') return fail(res, { ...out, message: 'Order not found.' });
  if (out.error) return fail(res, out);
  res.json({ success: true, order: out.order });
}));

module.exports = router;
