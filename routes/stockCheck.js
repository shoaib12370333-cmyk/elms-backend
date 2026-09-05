const express = require('express');
const router = express.Router();
const { runStockCheck } = require('../jobs/stockMonitor');

/**
 * POST /api/stock-check/run
 *
 * Manually triggers the same stock check that normally runs once a day,
 * for whichever users are currently due based on their own interval
 * setting. Useful for testing without waiting for the scheduled run.
 */
router.post('/run', async (req, res) => {
  try {
    await runStockCheck();
    res.json({ success: true, message: 'Stock check completed.' });
  } catch (err) {
    console.error('manual stock-check error:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Stock check failed.' });
  }
});

module.exports = router;
