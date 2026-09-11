const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const {
  listAllUsers,
  setCreditBalance,
  setStockCheckInterval,
  setMaxEbayAccounts,
} = require('../models/usersModel');
const { listAllTickets, resolveTicket } = require('../models/supportTicketsModel');
const { createPlan, updatePlan, deletePlan, listAllPlans } = require('../models/plansModel');
const {
  getSettings,
  updateWelcomeBonusSettings,
  updateChromeExtensionId,
  updateExtensionRegistrationUrl,
  getActionCostSettings,
  updateActionCosts,
} = require('../models/settingsModel');

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
 * PUT /api/admin/users/:id/max-ebay-accounts
 * Body: { max: number }
 *
 * Sets how many eBay accounts this user is allowed to connect at once.
 */
router.put('/users/:id/max-ebay-accounts', async (req, res) => {
  const { max } = req.body;

  const numericMax = Number(max);
  if (max == null || !Number.isInteger(numericMax) || numericMax < 0 || numericMax > 50) {
    return res.status(400).json({ success: false, error: 'Max eBay accounts must be a whole number from 0 to 50.' });
  }

  const user = await setMaxEbayAccounts(req.params.id, numericMax);
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

/**
 * GET /api/admin/settings
 * Returns the current global app settings (welcome bonus, etc).
 */
router.get('/settings', async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, settings });
});

/**
 * PUT /api/admin/settings/welcome-bonus
 * Body: { welcomeBonusEnabled?: boolean, welcomeBonusCredits?: number }
 *
 * Updates the welcome bonus: how many credits (if any) a brand-new user
 * receives automatically when they create their account.
 */
router.put('/settings/welcome-bonus', async (req, res) => {
  const { welcomeBonusEnabled, welcomeBonusCredits } = req.body;

  if (welcomeBonusCredits !== undefined && (Number.isNaN(Number(welcomeBonusCredits)) || Number(welcomeBonusCredits) < 0)) {
    return res.status(400).json({ success: false, error: 'welcomeBonusCredits must be a non-negative number.' });
  }

  const settings = await updateWelcomeBonusSettings({
    welcomeBonusEnabled: welcomeBonusEnabled !== undefined ? Boolean(welcomeBonusEnabled) : undefined,
    welcomeBonusCredits: welcomeBonusCredits !== undefined ? Number(welcomeBonusCredits) : undefined,
  });

  res.json({ success: true, settings });
});


/**
 * PUT /api/admin/settings/chrome-extension
 * Body: { chromeExtensionId: string }
 *
 * Stores the published Chrome extension ID in MongoDB. This lets the admin
 * enable the production extension from the Admin Panel without editing .env.
 */
router.put('/settings/chrome-extension', async (req, res) => {
  const raw = req.body?.chromeExtensionId;
  const chromeExtensionId = String(raw || '').trim().toLowerCase();

  if (chromeExtensionId && !/^[a-p]{32}$/.test(chromeExtensionId)) {
    return res.status(400).json({ success: false, error: 'Enter the 32-character Chrome extension ID.' });
  }

  const settings = await updateChromeExtensionId(chromeExtensionId);
  res.json({ success: true, settings });
});

/**
 * PUT /api/admin/settings/extension-registration-url
 * Body: { extensionRegistrationUrl: string }
 *
 * Controls the public registration link displayed by the Chrome extension.
 */
router.put('/settings/extension-registration-url', async (req, res) => {
  try {
    const settings = await updateExtensionRegistrationUrl(req.body?.extensionRegistrationUrl);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not save registration URL.' });
  }
});

/**
 * GET /api/admin/settings/action-costs
 *
 * Returns every billable (and non-billable) action in ELMS - what it does,
 * whether it calls the paid Canopy API, and its current credit cost (a
 * saved override if one exists, otherwise the code default) - for the
 * Admin Panel's "Credit Costs" list.
 */
router.get('/settings/action-costs', async (req, res) => {
  const actionCosts = await getActionCostSettings();
  res.json({ success: true, actionCosts });
});

/**
 * PUT /api/admin/settings/action-costs
 * Body: { costs: { <ACTION_KEY>: number, ... } }
 *
 * Saves new credit costs for one or more actions (see ACTION_COST_METADATA
 * in config/actionCosts.js for the valid keys). Takes effect immediately,
 * for every user, with no redeploy - see settingsModel.updateActionCosts.
 */
router.put('/settings/action-costs', async (req, res) => {
  const { costs } = req.body || {};

  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    return res.status(400).json({ success: false, error: 'A "costs" object is required.' });
  }

  try {
    const actionCosts = await updateActionCosts(costs);
    res.json({ success: true, actionCosts });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not save these credit costs.' });
  }
});

module.exports = router;
