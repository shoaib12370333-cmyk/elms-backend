const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { getPricingRule, setPricingRule } = require('../models/usersModel');
const { DEFAULT_RULE, FIELD_LIMITS, MAX_TIERS, normalizeRule, computePrice } = require('../services/pricingService');

const shape = (rule) => ({ ...DEFAULT_RULE, ...(rule || {}), tiers: (rule && rule.tiers) || [] });

/**
 * GET /api/pricing/rule
 * The seller's pricing rule (the defaults, switched off, when they never set one) and the limits of every field.
 */
router.get('/rule', requireAuth, async (req, res) => {
  const stored = await getPricingRule(req.userId);
  res.json({ success: true, rule: shape(stored), isSet: !!stored, limits: FIELD_LIMITS, maxTiers: MAX_TIERS });
});

/**
 * PUT /api/pricing/rule   { enabled, currency, feePercent, feeFixed, profitPercent, profitFixed, minProfit, shipping, centsEnding, tiers }
 * Saves the rule. A value that is out of range or not a number is refused (400), never corrected by itself.
 */
router.put('/rule', requireAuth, async (req, res) => {
  const { rule, errors } = normalizeRule(req.body);
  if (!rule) return res.status(400).json({ success: false, error: errors[0], errors });
  const saved = await setPricingRule(req.userId, rule);
  res.json({ success: true, rule: shape(saved) });
});

/**
 * POST /api/pricing/preview   { cost, rule? }
 * What the rule gives for a product that costs `cost`, with every part of it. Uses the rule sent (so a form that is not saved yet
 * can be tried) or, without one, the saved rule. The same function that prices a real import, so the preview is the price.
 */
router.post('/preview', requireAuth, async (req, res) => {
  const cost = Number(req.body && req.body.cost);
  if (!Number.isFinite(cost) || cost <= 0) return res.status(400).json({ success: false, error: 'Enter what the product costs, a number above 0.' });
  let rule;
  if (req.body && req.body.rule) {
    const checked = normalizeRule(req.body.rule);
    if (!checked.rule) return res.status(400).json({ success: false, error: checked.errors[0], errors: checked.errors });
    rule = checked.rule;
  } else {
    const stored = await getPricingRule(req.userId);
    const checked = normalizeRule(stored || DEFAULT_RULE);
    if (!checked.rule) return res.status(400).json({ success: false, error: checked.errors[0], errors: checked.errors });
    rule = checked.rule;
  }
  const breakdown = computePrice(cost, rule);
  if (!breakdown) return res.status(400).json({ success: false, error: 'This rule cannot price that cost.' });
  res.json({ success: true, breakdown });
});

module.exports = router;
