const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/requireAdmin');
const { isSuperAdminEmail, superAdminEmail } = require('../services/superAdmin');
const User = require('../models/schemas/User');
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
  updateImportPolicy,
  updateChromeExtensionId,
  updateExtensionRegistrationUrl,
  updateExtensionBackendUrl,
  getActionCostSettings,
  updateActionCosts,
  getAiSettings,
  updateAiSettings,
} = require('../models/settingsModel');

// Every route in this file requires the user to be signed in AND an admin.
router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/ebay-usage
 * How much of eBay's daily Trading API allowance is used today (all sellers together) and what the last background
 * statistics run did. `viewsInBulk: false` means eBay's bulk answer carries no view counts (they are then read a few at a time).
 */
router.get('/ebay-usage', async (req, res) => {
  const { snapshot } = require('../services/ebayCallBudget');
  const { getLastRun } = require('../services/listingStatsService');
  const { fetchRateLimits } = require('../services/ebayRateLimitService');
  // eBay's own count of every API allowance (Analytics API getRateLimits); shown next to ELMS's Trading budget, and left out when eBay does not answer.
  let ebay = null;
  let ebayError = null;
  try { ebay = await fetchRateLimits({ force: req.query.refresh === '1' }); } catch (err) { ebayError = err.message || 'eBay did not answer.'; }
  res.json({ success: true, usage: await snapshot(), lastStatsRun: getLastRun(), ebay, ebayError });
});

/**
 * Admin access. Only the super admin can see or change who has the admin panel.
 * GET /api/admin/admins            -> everyone who has it
 * POST /api/admin/admins {email}   -> gives it to an existing ELMS user
 * DELETE /api/admin/admins/:id     -> takes it away (never from the super admin)
 */
const adminRow = (u) => ({ id: String(u._id), email: u.email, name: u.name || null, isSuperAdmin: isSuperAdminEmail(u.email) });

router.get('/admins', requireSuperAdmin, async (req, res) => {
  const rows = await User.find({ $or: [{ role: 'admin' }, { email: superAdminEmail() }] }, { email: 1, name: 1 }).lean();
  const admins = rows.map(adminRow).sort((a, b) => Number(b.isSuperAdmin) - Number(a.isSuperAdmin) || String(a.email).localeCompare(String(b.email)));
  res.json({ success: true, admins });
});

router.post('/admins', requireSuperAdmin, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  const user = await User.findOneAndUpdate({ email }, { $set: { role: 'admin' } }, { new: true, projection: { email: 1, name: 1 } }).lean();
  if (!user) return res.status(404).json({ success: false, error: 'No ELMS user has that email. They need to sign up or sign in to ELMS once first.' });
  res.json({ success: true, admin: adminRow(user) });
});

router.delete('/admins/:id', requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ success: false, error: 'Admin not found.' });
  const user = await User.findById(id, { email: 1, name: 1, role: 1 }).lean();
  if (user && isSuperAdminEmail(user.email)) return res.status(403).json({ success: false, error: 'The super admin cannot be removed.' });
  if (!user || user.role !== 'admin') return res.status(404).json({ success: false, error: 'That user is not an admin.' });
  await User.updateOne({ _id: id }, { $set: { role: 'user' } });
  res.json({ success: true });
});

/**
 * GET /api/admin/users
 * Returns every user, for the Admin Panel's user list.
 */
router.get('/users', async (req, res) => {
  // Each user also carries: online / minutes since they left, paid or free plan, last sign-in IP + place, suspended.
  const { users, summary } = await require('../services/adminUserStatsService').enrichUsers(await listAllUsers());
  res.json({ success: true, users, summary });
});

/** One CSV cell: quoted when it holds a comma, a quote or a line break. */
const csvCell = (value) => (/[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);

/**
 * GET /api/admin/users/:id/draft-links
 * A CSV file with the Amazon link of every draft of that user, one link per row (column "Amazon link") and nothing else. It is a plain
 * read: the user is not told and nothing is recorded. 404 with a message when the user has no draft with a saved link.
 */
router.get('/users/:id/draft-links', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ success: false, error: 'User not found.' });
  const user = await User.findById(id, { _id: 1 }).lean();
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  const links = await require('../models/listingsModel').listDraftAmazonLinks(id);
  if (!links.length) return res.status(404).json({ success: false, error: 'This user has no drafts with an Amazon link.' });
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="draft-amazon-links-' + day + '.csv"');
  res.send(['Amazon link', ...links.map(csvCell)].join('\r\n') + '\r\n');
});

/**
 * PUT /api/admin/users/:id/credits
 * Body: { creditBalance: number }
 *
 * Sets a user's credit balance directly (e.g. after they pay outside the app).
 */
router.put('/users/:id/credits', async (req, res) => {
  const { creditBalance } = req.body;

  if (creditBalance == null || creditBalance === '' || !Number.isFinite(Number(creditBalance)) || Number(creditBalance) < 0 || Number(creditBalance) > 10000000) {
    return res.status(400).json({ success: false, error: 'A credit balance between 0 and 10,000,000 is required.' });
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
  let emailed = false;
  if (adminReply && String(adminReply).trim() && (ticket.userId || ticket.fromEmail)) {
    try {
      // A ticket that came in as an email goes back to whoever wrote it (they may have no ELMS account);
      // an in-app ticket goes to the account's email.
      let to = ticket.fromEmail || null;
      if (!to && ticket.userId) {
        const { getUserById } = require('../models/usersModel');
        const owner = await getUserById(ticket.userId);
        to = owner && owner.email ? owner.email : null;
      }
      if (to) {
        await require('../services/emailService').sendTicketReplyEmail({ to, subject: ticket.subject, reply: String(adminReply).trim(), ref: ticket.ref, inReplyTo: ticket.emailMessageId || undefined });
        emailed = true;
      }
    } catch (mailErr) {
      console.warn('ticket reply email failed:', mailErr.message);
    }
  }

  res.json({ success: true, ticket, emailed });
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
  const { name, priceUsd, credits, paddlePriceId, maxEbayAccounts, yearlyPriceUsd } = req.body;

  if (!name || !(Number(priceUsd) > 0) || !(Number(credits) > 0)) {
    return res.status(400).json({ success: false, error: 'A name, a price and the number of credits are required.' });
  }
  // CashTap's smallest checkout is $0.50.
  if (Number(priceUsd) < 0.5) return res.status(400).json({ success: false, error: 'The price must be at least $0.50.' });

  const plan = await createPlan({
    name,
    priceUsd: Number(priceUsd),
    credits: Number(credits),
    paddlePriceId: paddlePriceId || null,
    maxEbayAccounts: Number(maxEbayAccounts) > 0 ? Number(maxEbayAccounts) : null,
    yearlyPriceUsd,
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
 * GET /api/admin/settings/custom-plan  ->  the custom plan a buyer builds (dollars a month, credits per dollar, yearly discount, eBay stores)
 * PUT /api/admin/settings/custom-plan  ->  saves it (only the fields sent change)
 */
router.get('/settings/custom-plan', async (req, res) => {
  res.json({ success: true, custom: await require('../models/settingsModel').getCustomPlanSettings() });
});

router.put('/settings/custom-plan', async (req, res) => {
  try {
    res.json({ success: true, custom: await require('../models/settingsModel').updateCustomPlanSettings(req.body || {}) });
  } catch (err) {
    res.status(err.userFacing ? err.statusCode : 500).json({ success: false, error: err.userFacing ? err.message : 'Could not save the custom plan settings.' });
  }
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
 * PUT /api/admin/settings/import-policy
 * Body: { importWithoutEbayAccount: boolean }
 *
 * May a person import products (extension, website, bulk) before any eBay store is connected? On: the draft is saved without a store
 * and a store is chosen when it is published. Off: they are asked to connect a store first.
 */
router.put('/settings/import-policy', async (req, res) => {
  const { importWithoutEbayAccount } = req.body || {};
  if (typeof importWithoutEbayAccount !== 'boolean') {
    return res.status(400).json({ success: false, error: 'importWithoutEbayAccount must be true or false.' });
  }
  const settings = await updateImportPolicy({ importWithoutEbayAccount });
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
router.put('/settings/extension-backend-url', async (req, res) => {
  try {
    const settings = await updateExtensionBackendUrl(req.body?.extensionBackendUrl);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not save backend URL.' });
  }
});

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

/**
 * GET /api/admin/settings/ai
 * AI switches, model, tone settings, the live credit cost of each AI action, key status and 30-day usage.
 */
router.get('/settings/ai', async (req, res) => {
  const AiUsage = require('../models/schemas/AiUsage');
  const { ACTION_COSTS } = require('../config/actionCosts');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [settings, usage] = await Promise.all([
    getAiSettings(),
    AiUsage.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { kind: '$kind', ok: '$ok' }, calls: { $sum: 1 }, credits: { $sum: '$credits' }, input: { $sum: '$inputTokens' }, output: { $sum: '$outputTokens' } } },
    ]),
  ]);
  const summary = { title: { calls: 0, failed: 0, credits: 0 }, description: { calls: 0, failed: 0, credits: 0 }, aspects: { calls: 0, failed: 0, credits: 0 }, reply: { calls: 0, failed: 0, credits: 0 }, vero: { calls: 0, failed: 0, credits: 0 }, inputTokens: 0, outputTokens: 0 };
  for (const row of usage) {
    const bucket = summary[row._id.kind];
    if (!bucket) continue;
    if (row._id.ok) { bucket.calls += row.calls; bucket.credits += row.credits; } else bucket.failed += row.calls;
    summary.inputTokens += row.input; summary.outputTokens += row.output;
  }
  res.json({ success: true, settings, apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY, costs: { AI_TITLE: ACTION_COSTS.AI_TITLE, AI_DESCRIPTION: ACTION_COSTS.AI_DESCRIPTION, AI_ASPECTS: ACTION_COSTS.AI_ASPECTS, AI_REPLY: ACTION_COSTS.AI_REPLY }, usage: summary });
});

/**
 * PUT /api/admin/settings/ai
 * Body: any of { aiTitleEnabled, aiDescriptionEnabled, aiModel, aiDescriptionLength, aiCustomInstructions, costs: { AI_TITLE, AI_DESCRIPTION } }
 */
router.put('/settings/ai', async (req, res) => {
  try {
    const { costs, ...rest } = req.body || {};
    const settings = await updateAiSettings(rest);
    let savedCosts = null;
    if (costs && typeof costs === 'object') {
      const pick = {};
      for (const k of ['AI_TITLE', 'AI_DESCRIPTION', 'AI_ASPECTS', 'AI_REPLY']) if (costs[k] !== undefined) pick[k] = costs[k];
      if (Object.keys(pick).length) await updateActionCosts(pick);
    }
    const { ACTION_COSTS } = require('../config/actionCosts');
    savedCosts = { AI_TITLE: ACTION_COSTS.AI_TITLE, AI_DESCRIPTION: ACTION_COSTS.AI_DESCRIPTION, AI_ASPECTS: ACTION_COSTS.AI_ASPECTS, AI_REPLY: ACTION_COSTS.AI_REPLY };
    res.json({ success: true, settings, costs: savedCosts });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not save the AI settings.' });
  }
});

/** GET/PUT /api/admin/settings/limits - bulk import size and mail sending caps. */
router.get('/settings/limits', async (req, res) => {
  const { getLimits } = require('../models/settingsModel');
  res.json({ success: true, limits: await getLimits() });
});
router.put('/settings/limits', async (req, res) => {
  try {
    const { updateLimits } = require('../models/settingsModel');
    res.json({ success: true, limits: await updateLimits(req.body || {}) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Announcements (bulk mail). Sent in small batches by jobs/announcementSender.js. */
router.get('/announcements', async (req, res) => {
  const Announcement = require('../models/schemas/Announcement');
  const svc = require('../services/announcementService');
  const { getLimits } = require('../models/settingsModel');
  const [list, recipients, used, limits] = await Promise.all([
    Announcement.find().sort({ createdAt: -1 }).limit(20).lean(),
    svc.countRecipients(),
    svc.sentToday(),
    getLimits(),
  ]);
  res.json({
    success: true,
    recipients,
    sentToday: used,
    limits: { mailBatchSize: limits.mailBatchSize, mailDailyCap: limits.mailDailyCap },
    from: svc.senderAddress('support'),
    senders: require('../services/emailService').availableSenders(),
    announcements: list.map((a) => ({ id: String(a._id), subject: a.subject, status: a.status, total: a.total, sent: a.sent, failed: a.failed, retryable: (a.failedUsers || []).length, lastError: a.lastError || null, createdAt: a.createdAt, finishedAt: a.finishedAt })),
  });
});
/** The sender the admin chose (support when none); it must be one that is set up. */
function readSender(body) {
  const id = String((body && body.sender) || 'support');
  const senders = require('../services/emailService').availableSenders();
  if (senders.some((s) => s.id === id)) return id;
  if (!body || !body.sender) return senders.some((s) => s.id === 'support') ? 'support' : (senders[0] ? senders[0].id : 'support');
  throw new Error('Choose one of the configured senders.');
}
function readAnnouncement(body) {
  const subject = String((body && body.subject) || '').trim();
  const text = String((body && body.body) || '').trim();
  if (subject.length < 3 || subject.length > 150) throw new Error('Subject must be 3 to 150 characters.');
  if (text.length < 10 || text.length > 8000) throw new Error('Message must be 10 to 8000 characters.');
  return { subject, body: text, sender: readSender(body) };
}
router.post('/announcements/test', async (req, res) => {
  try {
    const msg = readAnnouncement(req.body);
    const { getUserById } = require('../models/usersModel');
    const me = await getUserById(req.userId);
    await require('../services/announcementService').sendTest({ to: me.email, ...msg });
    res.json({ success: true, to: me.email });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not send the test mail.' });
  }
});
/**
 * POST /api/admin/mail/send  { from, to, subject, body }
 * One mail to any address, from one of the configured senders (GET /api/admin/announcements lists them as "senders").
 */
const mailLimiter = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many mails from the admin panel. Try again in an hour.' } });
router.post('/mail/send', mailLimiter, async (req, res) => {
  try {
    const to = String((req.body && req.body.to) || '').trim();
    const subject = String((req.body && req.body.subject) || '').trim();
    const body = String((req.body && req.body.body) || '').trim();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || to.length > 254) throw new Error('Enter one valid email address to send to.');
    if (subject.length < 2 || subject.length > 150 || /[\r\n]/.test(subject)) throw new Error('The subject must be 2 to 150 characters on one line.');
    if (body.length < 2 || body.length > 8000) throw new Error('The message must be 2 to 8000 characters.');
    const from = readSender({ sender: req.body && req.body.from });
    await require('../services/emailService').sendCustomMail({ from, to, subject, body });
    console.log('[admin-mail] ' + req.userId + ' sent a mail to ' + to + ' from ' + from);
    res.json({ success: true, to, from });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not send the mail.' });
  }
});

router.post('/announcements', async (req, res) => {
  try {
    const msg = readAnnouncement(req.body);
    const ann = await require('../services/announcementService').startAnnouncement({ ...msg, createdBy: req.userId });
    res.json({ success: true, id: String(ann._id), total: ann.total });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not start the announcement.' });
  }
});
router.post('/announcements/:id/retry-failed', async (req, res) => {
  try {
    const n = await require('../services/announcementService').retryFailed(req.params.id);
    res.json({ success: true, retrying: n });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
router.post('/announcements/:id/:action(pause|resume|cancel)', async (req, res) => {
  const Announcement = require('../models/schemas/Announcement');
  const next = { pause: 'paused', resume: 'sending', cancel: 'cancelled' }[req.params.action];
  const from = req.params.action === 'resume' ? ['paused'] : ['sending', 'paused'];
  const ann = await Announcement.findOneAndUpdate({ _id: req.params.id, status: { $in: from } }, req.params.action === 'resume' ? { status: next, lastError: null } : { status: next }, { new: true });
  if (!ann) return res.status(404).json({ success: false, error: 'Announcement not found or already finished.' });
  res.json({ success: true, status: ann.status });
});

/**
 * GET /api/admin/overview
 * Headline numbers for the Admin Panel's Overview tab plus service health.
 */
router.get('/overview', async (req, res) => {
  const User = require('../models/schemas/User');
  const Listing = require('../models/schemas/Listing');
  const Order = require('../models/schemas/Order');
  const Purchase = require('../models/schemas/Purchase');
  const EbayAccount = require('../models/schemas/EbayAccount');
  const SupportTicket = require('../models/schemas/SupportTicket');
  const AiUsage = require('../models/schemas/AiUsage');
  const day = 24 * 60 * 60 * 1000;
  const d7 = new Date(Date.now() - 7 * day);
  const d30 = new Date(Date.now() - 30 * day);
  const [users, newUsers, creditAgg, stores, listingAgg, orders, openTickets, revenueAgg, revenue30Agg, aiCalls30, recentUsers, recentPurchases] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: d7 } }),
    User.aggregate([{ $match: { role: { $ne: 'admin' } } }, { $group: { _id: null, credits: { $sum: '$creditBalance' } } }]),
    EbayAccount.countDocuments(),
    Listing.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Order.countDocuments(),
    SupportTicket.countDocuments({ status: 'open' }),
    Purchase.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, usd: { $sum: '$priceUsd' }, credits: { $sum: '$creditsGranted' }, n: { $sum: 1 } } }]),
    Purchase.aggregate([{ $match: { status: 'completed', createdAt: { $gte: d30 } } }, { $group: { _id: null, usd: { $sum: '$priceUsd' }, n: { $sum: 1 } } }]),
    AiUsage.countDocuments({ createdAt: { $gte: d30 }, ok: true }),
    User.find().sort({ createdAt: -1 }).limit(5).select('email name createdAt creditBalance').lean(),
    Purchase.find().sort({ createdAt: -1 }).limit(5).populate('userId', 'email').lean(),
  ]);
  const byStatus = Object.fromEntries(listingAgg.map((r) => [r._id, r.n]));
  res.json({
    success: true,
    totals: {
      users, newUsers7d: newUsers, storesConnected: stores, orders, openTickets,
      creditsOutstanding: creditAgg[0]?.credits || 0,
      revenueUsd: revenueAgg[0]?.usd || 0, revenue30dUsd: revenue30Agg[0]?.usd || 0, purchases: revenueAgg[0]?.n || 0, purchases30d: revenue30Agg[0]?.n || 0,
      creditsSold: revenueAgg[0]?.credits || 0, aiCalls30d: aiCalls30,
    },
    listings: { draft: byStatus.draft || 0, publishing: byStatus.publishing || 0, published: byStatus.published || 0, error: byStatus.error || 0, scheduled: byStatus.scheduled || 0 },
    health: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      canopy: !!process.env.CANOPY_API_KEY,
      easyparser: !!process.env.EASYPARSER_API_KEY,
      paddle: !!(process.env.PADDLE_API_KEY || process.env.PADDLE_WEBHOOK_SECRET),
      cashtap: !!(process.env.CASHTAP_SECRET_KEY && process.env.CASHTAP_WEBHOOK_SECRET),
      ebay: !!((process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET)),
      email: !!((process.env.SMTP_HOST && process.env.SMTP_USER)),
    },
    recentUsers: recentUsers.map((u) => ({ id: String(u._id), email: u.email, name: u.name || null, createdAt: u.createdAt, creditBalance: u.creditBalance })),
    recentPurchases: recentPurchases.map((p) => ({ id: String(p._id), email: p.userId?.email || null, priceUsd: p.priceUsd, credits: p.creditsGranted, createdAt: p.createdAt })),
  });
});

module.exports = router;
