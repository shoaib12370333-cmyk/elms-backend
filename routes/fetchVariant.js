const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { fetchProductByAsin } = require('../services/canopyAmazonService');
const { requireAuth } = require('../middleware/requireAuth');
const { ACTION_COSTS } = require('../config/actionCosts');
const { withCredits } = require('../services/creditService');
const Import = require('../models/schemas/Import');

// Every call here is a paid Amazon lookup, so it is limited three ways: a person can only ask about a product they imported (or one
// of its variants), at a limited pace, and the same product asked again within a few minutes is not looked up again.
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => String(req.userId),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many variant lookups. Please try again in a few minutes.' },
});

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // "country:ASIN" -> { at, product }

/** The product is one the person imported, or one of that product's variants. */
async function isOneOfMine(userId, asin) {
  return !!(await Import.exists({ userId, $or: [{ asin }, { 'product.asin': asin }, { 'product.variants.asin': asin }] }));
}

/**
 * POST /api/fetch-variant
 * Requires a valid session token. Costs ACTION_COSTS.VARIANT_REFRESH (free by default; whatever the admin sets in the Admin Panel
 * is charged, and given back if the lookup fails).
 * Body: { asin: string, amazonDomain?: string, markupPercent?: number }
 *
 * When the user clicks a variant (color/size), fetches that variant's own fresh data (price, title, availability, etc.) using its ASIN.
 */
router.post('/', requireAuth, limiter, async (req, res) => {
  const { amazonDomain, markupPercent } = req.body;
  const asin = String(req.body.asin || '').trim().toUpperCase();

  if (!asin) {
    return res.status(400).json({ error: 'The asin field is required.' });
  }
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ success: false, error: 'That does not look like an Amazon product code (ASIN).' });
  }

  try {
    if (!(await isOneOfMine(req.userId, asin))) {
      return res.status(404).json({ success: false, error: 'That product is not one of your imports.' });
    }

    const country = String(amazonDomain || '');
    const key = country + ':' + asin;
    const product = await withCredits(req.userId, ACTION_COSTS.VARIANT_REFRESH, async () => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.product;
      const fresh = await fetchProductByAsin(asin, amazonDomain);
      if (cache.size >= 500) cache.clear();
      cache.set(key, { at: Date.now(), product: fresh });
      return fresh;
    });

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
    if (!err.outOfCredits) console.error('fetch-variant error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Something went wrong.',
    });
  }
});

module.exports = router;
module.exports.isOneOfMine = isOneOfMine;
