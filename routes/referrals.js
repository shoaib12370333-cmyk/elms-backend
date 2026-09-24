const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const referrals = require('../services/referralService');
const { requestContext } = require('../services/sessionTracker');

// The sign-up form asks whether a code is good before the account exists: no sign-in, but limited so codes cannot be guessed.
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many checks. Please try again in a few minutes.' },
});

const REASONS = {
  disabled: 'The referral programme is not running right now.',
  invalid_code: 'That referral code is not valid.',
  self: 'You cannot use your own referral code.',
  already: 'A referral code is already on your account.',
  has_purchases: 'A referral code can only be added before your first purchase.',
  too_late: 'A referral code can only be added in the first ' + referrals.LATE_CODE_DAYS + ' days after signing up.',
  no_user: 'Account not found.',
};

/**
 * GET /api/referrals/check?code=ABC123
 * No sign-in. { success, valid, discountPercent, discountUses, discountDays } - what a friend who uses this code gets.
 */
router.get('/check', checkLimiter, async (req, res) => {
  try {
    const result = await referrals.checkCode(req.query.code);
    res.json({ success: true, ...result, ...(result.valid ? {} : { message: REASONS[result.reason] || REASONS.invalid_code }) });
  } catch (err) {
    console.error('referral check error:', err.message);
    res.status(500).json({ success: false, error: 'Could not check the code right now.' });
  }
});

/**
 * GET /api/referrals/me
 * The Refer & Earn page: the person's code and link, what a friend gets, their numbers and their friends (addresses masked),
 * and - when they were referred themselves - the discount they still have.
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const page = await referrals.pageFor(req.userId);
    if (!page) return res.status(404).json({ success: false, error: 'User not found.' });
    res.json({ success: true, ...page });
  } catch (err) {
    console.error('referral page error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load your referral page right now.' });
  }
});

/**
 * POST /api/referrals/apply   Body: { code }
 * Adds a code to an existing account (someone who signed up without one), before their first purchase.
 */
router.post('/apply', requireAuth, async (req, res) => {
  try {
    const result = await referrals.addLateCode({ userId: req.userId, code: req.body && req.body.code, ip: requestContext(req).ip });
    if (!result.applied) return res.status(400).json({ success: false, reason: result.reason, error: REASONS[result.reason] || REASONS.invalid_code });
    res.json({ success: true, discountPercent: result.discountPercent, discountUses: result.discountUses, discountDays: result.discountDays });
  } catch (err) {
    console.error('referral apply error:', err.message);
    res.status(500).json({ success: false, error: 'Could not add the code right now.' });
  }
});

module.exports = router;
module.exports.REASONS = REASONS;
