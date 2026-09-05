const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { listActivePlans, getPlanById } = require('../models/plansModel');
const { listPurchasesForUser } = require('../models/purchasesModel');
const { getUserById } = require('../models/usersModel');
const { createTransaction } = require('../services/paddleService');

/**
 * GET /api/payments/plans
 * Requires a valid session token.
 * Returns every active plan, for the Pricing page.
 */
router.get('/plans', requireAuth, async (req, res) => {
  const plans = await listActivePlans();
  res.json({ success: true, plans });
});

/**
 * GET /api/payments/history
 * Requires a valid session token.
 * Returns the current user's own purchase history.
 */
router.get('/history', requireAuth, async (req, res) => {
  const purchases = await listPurchasesForUser(req.userId);
  res.json({ success: true, purchases });
});

/**
 * POST /api/payments/checkout
 * Requires a valid session token.
 * Body: { planId: string }
 *
 * Creates a Paddle transaction for the chosen plan and returns its
 * transaction ID, which the frontend passes to Paddle.js to open the
 * checkout overlay.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  const { planId } = req.body;

  if (!planId) {
    return res.status(400).json({ success: false, error: 'A planId is required.' });
  }

  const plan = await getPlanById(planId);
  if (!plan || !plan.active) {
    return res.status(404).json({ success: false, error: 'This plan is not available.' });
  }

  const user = await getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  try {
    const { transactionId } = await createTransaction({
      paddlePriceId: plan.paddlePriceId,
      userId: req.userId,
      userEmail: user.email,
    });

    res.json({ success: true, transactionId });
  } catch (err) {
    console.error('paddle checkout creation error:', err.message);
    res.status(500).json({ success: false, error: 'Could not start checkout. Please try again.' });
  }
});

module.exports = router;
