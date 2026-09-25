const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { getUserById } = require('../models/usersModel');
const affiliates = require('../services/affiliateService');

router.use(requireAuth);

const wrap = (fn) => async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
    res.json({ success: true, ...(await fn(user, req)) });
  } catch (err) {
    if (err.userFacing) return res.status(err.statusCode || 400).json({ success: false, error: err.message });
    console.error('affiliate route error:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

/** GET /api/affiliate/me - the Affiliate page: status, link, numbers, commissions, payouts. */
router.get('/me', wrap(async (user) => ({ affiliate: await affiliates.dashboard(user) })));

/** POST /api/affiliate/apply { network, address, promo } */
router.post('/apply', wrap(async (user, req) => {
  await affiliates.apply(user, req.body || {});
  return { affiliate: await affiliates.dashboard(user) };
}));

/** PUT /api/affiliate/payout-details { network, address } */
router.put('/payout-details', wrap(async (user, req) => {
  await affiliates.updatePayoutDetails(user, req.body || {});
  return { affiliate: await affiliates.dashboard(user) };
}));

/** POST /api/affiliate/payout - ask for the commissions that are ready. */
router.post('/payout', wrap(async (user) => {
  await affiliates.requestPayout(user);
  return { affiliate: await affiliates.dashboard(user) };
}));

module.exports = router;
