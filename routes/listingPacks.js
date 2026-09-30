const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { listActiveTiers, getTierById } = require('../models/listingPackTiersModel');
const { listPurchasesForUser } = require('../models/listingPackPurchasesModel');
const { getUserById } = require('../models/usersModel');
const cashtapPayments = require('../services/cashtapPaymentService');

/**
 * "Buy Listings" - a tab on the Buy Credits page. A buyer pays a fixed price for a fixed number of random, ready-to-list
 * drafts (services/listingCloneService.js), cloned straight from other sellers' already-categorized listings. CashTap
 * only (like the custom plan and yearly plans, there is no Paddle price for this).
 */

/**
 * GET /api/listing-packs
 * The tiers for the Buy Listings tab. 404 (not just an empty list) when CashTap is not the active payment provider - Paddle
 * has no price to sell this through.
 */
router.get('/', requireAuth, async (req, res) => {
  if (cashtapPayments.activeProvider() !== 'cashtap') return res.status(404).json({ success: false, error: 'Buy Listings is not available right now.' });
  const tiers = await listActiveTiers();
  res.json({ success: true, tiers });
});

/**
 * GET /api/listing-packs/history
 * The signed-in user's own Buy Listings purchases.
 */
router.get('/history', requireAuth, async (req, res) => {
  const purchases = await listPurchasesForUser(req.userId);
  res.json({ success: true, purchases });
});

/**
 * POST /api/listing-packs/checkout
 * Body: { tierId: string }
 * Creates a CashTap hosted checkout session for the tier and returns { sessionId, url } - the site sends the buyer there.
 * The listings are pushed once CashTap confirms the payment (webhook, or the return-page check below).
 */
router.post('/checkout', requireAuth, async (req, res) => {
  if (cashtapPayments.activeProvider() !== 'cashtap') return res.status(404).json({ success: false, error: 'Buy Listings is not available right now.' });
  const tier = await getTierById(req.body?.tierId);
  if (!tier || !tier.active) return res.status(404).json({ success: false, error: 'This listing pack is not available.' });

  const user = await getUserById(req.userId);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

  try {
    const { sessionId, url } = await cashtapPayments.startListingPackCheckout({ user, tier });
    res.json({ success: true, sessionId, url });
  } catch (err) {
    console.error('listing-pack checkout creation error:', err.message, err.requestId || '');
    res.status(500).json({ success: false, error: 'Could not start checkout. Please try again.' });
  }
});

/**
 * POST /api/listing-packs/confirm
 * Body: { sessionId: string }
 * The buyer is back from CashTap: ask CashTap whether the session is paid and push the listings if so (safe to call again
 * and again; the webhook may already have done it). Returns { status, granted, pushed, requested, tierName }.
 */
router.post('/confirm', requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!/^cs_[A-Za-z0-9_]{6,80}$/.test(sessionId)) return res.status(400).json({ success: false, error: 'A valid sessionId is required.' });
  try {
    const result = await cashtapPayments.confirmListingPackSession(sessionId, req.userId);
    if (result.reason === 'not_yours') return res.status(404).json({ success: false, error: 'Payment not found.' });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ success: false, error: 'Payment not found.' });
    console.error('listing-pack confirm error:', err.message, err.requestId || '');
    res.status(502).json({ success: false, error: 'Could not check the payment right now. Your listings are added automatically once it is confirmed.' });
  }
});

module.exports = router;
