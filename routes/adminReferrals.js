const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { isValidObjectIdString } = require('../services/validationService');
const { getReferralSettings, updateReferralSettings } = require('../models/settingsModel');
const model = require('../models/referralsModel');
const referrals = require('../services/referralService');

// Every route in this file requires the user to be signed in AND an admin.
router.use(requireAuth, requireAdmin);

/** A referrer as the admin table shows them: who, their code, the numbers, and what applies to their friends. */
function referrerRow(user, stats, config) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.username || null,
    code: user.referralCode,
    discountPercent: user.referralDiscountPercent, // null = the default
    rewardCredits: user.referralRewardCredits, // null = the default
    effectiveDiscountPercent: referrals.percentFor(user, config),
    effectiveRewardCredits: referrals.rewardFor(user, config),
    blocked: !!user.referralBlocked,
    signups: stats ? stats.signups : 0,
    buyers: stats ? stats.buyers : 0,
    revenueUsd: stats ? stats.revenueUsd : 0,
    creditsEarned: stats ? stats.creditsEarned : 0,
    lastAt: stats ? stats.lastAt : null,
  };
}

/**
 * GET /api/admin/referrals
 * The whole picture: the offer, totals, the best referrers and the latest sign-ups through a code.
 */
router.get('/', async (req, res) => {
  const [settings, totals, top, recent] = await Promise.all([getReferralSettings(), model.adminTotals(), model.topReferrers(25), model.recentReferrals(40)]);
  const users = await model.getUsersByIds([...top.map((t) => t.referrerId), ...recent.flatMap((r) => [r.referrerId, r.referredUserId])]);
  res.json({
    success: true,
    settings,
    totals,
    referrers: top.filter((t) => users.get(t.referrerId)).map((t) => referrerRow(users.get(t.referrerId), t, settings)),
    recent: recent.map((r) => ({
      id: r.id,
      at: r.createdAt,
      code: r.code,
      referrer: (users.get(r.referrerId) || {}).email || null,
      friend: (users.get(r.referredUserId) || {}).email || null,
      purchases: r.purchases,
      spentUsd: r.totalSpentUsd,
      rewardCredits: r.rewardCredits,
      status: r.firstPurchaseAt ? 'purchased' : 'signed_up',
    })),
  });
});

/**
 * PUT /api/admin/referrals/settings
 * Body: { enabled?, discountPercent?, discountUses?, discountDays?, rewardCredits? }
 */
router.put('/settings', async (req, res) => {
  try {
    const settings = await updateReferralSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/referrals/lookup?q=email-or-name-or-code
 * Finds people to give a special discount / reward / code to.
 */
router.get('/lookup', async (req, res) => {
  const [settings, found] = await Promise.all([getReferralSettings(), model.searchUsers(req.query.q, 8)]);
  const withStats = await Promise.all(found.map(async (u) => referrerRow(u, await model.referrerTotals(u.id), settings)));
  res.json({ success: true, users: withStats });
});

/**
 * PUT /api/admin/referrals/users/:id
 * Body: { discountPercent?: number|null, rewardCredits?: number|null, blocked?: boolean, code?: string }
 * The offer for ONE referrer: what their friends get off, what they earn, whether their code works, and a custom code.
 * null puts them back on the default offer.
 */
router.put('/users/:id', async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ success: false, error: 'User not found.' });
  const body = req.body || {};
  const update = {};

  if (body.discountPercent !== undefined) {
    if (body.discountPercent === null || body.discountPercent === '') update.discountPercent = null;
    else {
      const n = Number(body.discountPercent);
      if (!Number.isFinite(n) || n < 0 || n > referrals.MAX_DISCOUNT_PERCENT) return res.status(400).json({ success: false, error: 'The discount must be between 0 and ' + referrals.MAX_DISCOUNT_PERCENT + '%.' });
      update.discountPercent = referrals.clampPercent(n);
    }
  }
  if (body.rewardCredits !== undefined) {
    if (body.rewardCredits === null || body.rewardCredits === '') update.rewardCredits = null;
    else {
      const n = Number(body.rewardCredits);
      if (!Number.isFinite(n) || n < 0 || n > 1000000) return res.status(400).json({ success: false, error: 'The reward must be a number of credits from 0 to 1,000,000.' });
      update.rewardCredits = Math.floor(n);
    }
  }
  if (body.blocked !== undefined) update.blocked = !!body.blocked;

  try {
    if (!(await model.getUser(req.params.id))) return res.status(404).json({ success: false, error: 'User not found.' });
    if (body.code !== undefined && String(body.code).trim() !== '') await referrals.setCustomCode(req.params.id, body.code);
    else await referrals.ensureCode(req.params.id); // everybody the admin opens has a code
    const user = Object.keys(update).length ? await model.setReferrerOverrides(req.params.id, update) : await model.getUser(req.params.id);
    const settings = await getReferralSettings();
    res.json({ success: true, user: referrerRow(user, await model.referrerTotals(user.id), settings) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Could not save this referrer.' });
  }
});

module.exports = router;
