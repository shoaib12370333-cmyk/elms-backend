const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const {
  listAllUsers,
  setCreditBalance,
  setStockCheckInterval,
} = require('../models/usersModel');
const { listAllTickets, resolveTicket } = require('../models/supportTicketsModel');
const { createPlan, updatePlan, deletePlan, listAllPlans } = require('../models/plansModel');

// Every route in this file requires the user to be signed in AND an admin.
router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/users
 * Returns every user, for the Admin Panel's user list.
 */
router.get('/users', async (req, res) => {
  const users = await listAllUsers();
  res.json({ success: true, users });
});

/**
 * PUT /api/admin/users/:id/credits
 * Body: { creditBalance: number }
 *
 * Sets a user's credit balance directly (e.g. after they pay outside the app).
 */
router.put('/users/:id/credits', async (req, res) => {
  const { creditBalance } = req.body;

  if (creditBalance == null || Number.isNaN(Number(creditBalance)) || Number(creditBalance) < 0) {
    return res.status(400).json({ success: false, error: 'A non-negative creditBalance is required.' });
  }

  const user = await setCreditBalance(req.params.id, Number(creditBalance));
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  res.json({ success: true, user });
});

/**
 * PUT /api/admin/users/:id/stock-check-interval
 * Body: { days: number }
 *
 * Sets how many days must pass between this user's automatic stock checks.
 */
router.put('/users/:id/stock-check-interval', async (req, res) => {
  const { days } = req.body;

  if (days == null || Number.isNaN(Number(days)) || Number(days) < 1) {
    return res.status(400).json({ success: false, error: 'A days value of at least 1 is required.' });
  }

  const user = await setStockCheckInterval(req.params.id, Number(days));
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  res.json({ success: true, user });
});

/**
 * GET /api/admin/tickets
 * Returns every support ticket, across all users.
 */
router.get('/tickets', async (req, res) => {
  const tickets = await listAllTickets();
  res.json({ success: true, tickets });
});

/**
 * POST /api/admin/tickets/:id/resolve
 * Body: { adminReply?: string }
 *
 * Marks a support ticket resolved, optionally with a reply.
 */
router.post('/tickets/:id/resolve', async (req, res) => {
  const { adminReply } = req.body;

  const ticket = await resolveTicket(req.params.id, adminReply);
  if (!ticket) {
    return res.status(404).json({ success: false, error: 'Ticket not found.' });
  }

  res.json({ success: true, ticket });
});

/**
 * GET /api/admin/plans
 * Returns every plan (active and inactive), for the Admin Panel's "Manage Plans" list.
 */
router.get('/plans', async (req, res) => {
  const plans = await listAllPlans();
  res.json({ success: true, plans });
});

/**
 * POST /api/admin/plans
 * Body: { name, priceUsd, credits, paddlePriceId }
 *
 * Creates a new credit plan, linked to a Paddle price ID (from the Paddle
 * dashboard: Catalog > Products > your product > the price you created).
 */
router.post('/plans', async (req, res) => {
  const { name, priceUsd, credits, paddlePriceId } = req.body;

  if (!name || !priceUsd || !credits || !paddlePriceId) {
    return res.status(400).json({
      success: false,
      error: 'name, priceUsd, credits, and paddlePriceId are all required.',
    });
  }

  const plan = await createPlan({
    name,
    priceUsd: Number(priceUsd),
    credits: Number(credits),
    paddlePriceId,
  });
  res.json({ success: true, plan });
});

/**
 * PUT /api/admin/plans/:id
 * Body: { name?, priceUsd?, credits?, paddlePriceId?, active? }
 *
 * Updates an existing plan. Only provided fields are changed.
 */
router.put('/plans/:id', async (req, res) => {
  const plan = await updatePlan(req.params.id, req.body);
  if (!plan) {
    return res.status(404).json({ success: false, error: 'Plan not found.' });
  }
  res.json({ success: true, plan });
});

/**
 * DELETE /api/admin/plans/:id
 * Permanently removes a plan. Does not affect users who already purchased it.
 */
router.delete('/plans/:id', async (req, res) => {
  const deleted = await deletePlan(req.params.id);
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Plan not found.' });
  }
  res.json({ success: true });
});

module.exports = router;
