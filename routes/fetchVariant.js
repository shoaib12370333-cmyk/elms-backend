const express = require('express');
const router = express.Router();
const { fetchProductByAsin } = require('../services/canopyAmazonService');
const { requireAuth } = require('../middleware/requireAuth');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * POST /api/fetch-variant
 * Requires a valid session token. FREE (see config/actionCosts.js -
 * VARIANT_REFRESH is 0) - this only re-fetches details for a product
 * whose parent listing was already paid for at import time.
 * Body: { asin: string, amazonDomain?: string, markupPercent?: number }
 *
 * When the user clicks a variant (color/size), fetches that variant's own
 * fresh data (price, title, availability, etc.) using its ASIN.
 */
router.post('/', requireAuth, async (req, res) => {
  const { asin, amazonDomain, markupPercent } = req.body;

  if (!asin) {
    return res.status(400).json({ error: 'The asin field is required.' });
  }

  try {
    const product = await fetchProductByAsin(asin, amazonDomain);
    // ACTION_COSTS.VARIANT_REFRESH is 0 - no credit is charged here.

    let suggestedPrice = null;
    if (product.price != null && markupPercent != null) {
      const markup = Number(markupPercent);
      if (!Number.isNaN(markup)) {
        suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
      }
    }

    res.json({
      success: true,
      product,
      suggestedPrice,
    });
  } catch (err) {
    console.error('fetch-variant error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Something went wrong.',
    });
  }
});

module.exports = router;
