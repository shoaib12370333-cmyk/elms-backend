const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const vouchers = require('../services/voucherService');

/**
 * GET /api/vouchers
 * The signed-in user's own vouchers (newest first): { id, kind, description, note, state: active|used|expired|revoked,
 * planName, expiresAt, redeemable }. `redeemable` vouchers (credits, a free plan, eBay accounts) are used with POST /:id/redeem;
 * the others take money off a plan on Buy credits.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const list = await vouchers.listMine(req.userId);
    res.json({ success: true, vouchers: list, activeCount: list.filter((v) => v.state === 'active').length });
  } catch (err) {
    console.error('vouchers list error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load your vouchers.' });
  }
});

/**
 * POST /api/vouchers/:id/redeem
 * Uses a credits / free plan / eBay accounts voucher. Works once; only the owner can.
 */
router.post('/:id/redeem', requireAuth, async (req, res) => {
  try {
    const result = await vouchers.redeem(req.userId, String(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.userFacing) return res.status(err.statusCode).json({ success: false, error: err.message });
    console.error('voucher redeem error:', err.message);
    res.status(500).json({ success: false, error: 'Could not redeem this voucher. Please try again.' });
  }
});

module.exports = router;
