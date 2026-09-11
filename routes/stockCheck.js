const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { runStockCheck } = require('../jobs/stockMonitor');
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');

const manualStockCheckLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many manual stock checks. Please wait a few minutes.' },
});

// Manual stock checking is an operational/admin action, not a public API.
// Keep it behind both authentication and the admin role and rate-limit it.
router.post('/run', requireAuth, requireAdmin, manualStockCheckLimiter, async (req, res) => {
  try {
    await runStockCheck();
    res.json({ success: true, message: 'Stock check completed.' });
  } catch (err) {
    console.error('manual stock-check error:', err.message);
    res.status(500).json({ success: false, error: 'Stock check failed.' });
  }
});

module.exports = router;
