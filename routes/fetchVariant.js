const express = require('express');
const router = express.Router();
const { fetchProductByAsin } = require('../services/rapidAmazonService');
const { hasCredits, spendCredit } = require('../models/usersModel');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * POST /api/fetch-variant
 * Requires a valid session token and at least one credit.
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

  if (!(await hasCredits(req.userId))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

  try {
    const product = await fetchProductByAsin(asin, amazonDomain);
    await spendCredit(req.userId);

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
