const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getAffiliateSettings, updateAffiliateSettings } = require('../models/settingsModel');
const model = require('../models/affiliatesModel');
const affiliates = require('../services/affiliateService');
const rules = require('../services/affiliateRules');

router.use(requireAuth, requireAdmin);

const wrap = (fn) => async (req, res) => {
  try {
    res.json({ success: true, ...(await fn(req)) });
  } catch (err) {
    if (err.userFacing) return res.status(err.statusCode || 400).json({ success: false, error: err.message });
    console.error('admin affiliates error:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong.' });
  }
};

async function overview() {
  const settings = await getAffiliateSettings();
  const list = await model.listWithUsers();
  const byId = new Map(list.map((a) => [a.id, a]));
  const rows = await Promise.all(list.slice(0, 300).map(async (a) => ({
    ...a,
    effectivePercent: rules.percentFor(a, settings),
    networkLabel: a.payoutNetwork && rules.NETWORKS[a.payoutNetwork] ? rules.NETWORKS[a.payoutNetwork].label : null,
    link: affiliates.linkFor(a.code),
    totals: a.status === 'approved' || a.status === 'suspended' ? { ...(await model.totals(a.id)), signups: await model.signups(a.id) } : null,
  })));
  const payouts = (await model.listPayouts()).map((p) => ({ ...p, email: (byId.get(p.affiliateId) || {}).email || null, networkLabel: rules.NETWORKS[p.network] ? rules.NETWORKS[p.network].label : p.network }));
  return { settings, networks: rules.networkList(), affiliates: rows, payouts };
}

/** GET /api/admin/affiliates - settings, every affiliate (applications too) with their numbers, and the payout requests. */
router.get('/', wrap(overview));

/** PUT /api/admin/affiliates/settings { enabled, defaultPercent, holdDays, minPayoutUsd } */
router.put('/settings', wrap(async (req) => ({ settings: await updateAffiliateSettings(req.body || {}) })));

/** POST /api/admin/affiliates/payouts/:id/paid { txHash, note } | /reject { note } */
router.post('/payouts/:id/:action(paid|reject)', wrap(async (req) => ({ payout: await affiliates.processPayout(req.params.id, { action: req.params.action, ...(req.body || {}) }) })));

/** POST /api/admin/affiliates/:id/:action  (approve | reject | suspend | reactivate | save)  { percent, note } */
router.post('/:id/:action(approve|reject|suspend|reactivate|save)', wrap(async (req) => ({ affiliate: await affiliates.decide(req.params.id, req.params.action, req.body || {}) })));

module.exports = router;
