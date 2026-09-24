const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const extension = require('../services/extensionService');

// The panel asks once per product page the person opens; generous, but a script cannot hammer it.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait a moment.' },
});

const text = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/**
 * POST /api/extension/check
 * Body: { asin?, amazonUrl?, title?, brand?, bulletPoints? }
 * Free. What the extension's panel shows before an import: credits, the user's stores (and whether this Amazon site fits each),
 * what the user already has for this ASIN, and VeRO words in the product. Without an ASIN only credits and stores come back.
 */
router.post('/check', requireAuth, limiter, async (req, res) => {
  try {
    const body = req.body || {};
    const info = await extension.panelInfo({
      userId: req.userId,
      asin: text(body.asin, 32),
      amazonUrl: text(body.amazonUrl, 2000),
      title: text(body.title, 1000),
      brand: text(body.brand, 300),
      bulletPoints: Array.isArray(body.bulletPoints) ? body.bulletPoints.map((b) => text(b, 2000)).filter(Boolean).slice(0, 30) : [],
    });
    if (!info) return res.status(404).json({ success: false, error: 'User not found.' });
    res.json({ success: true, ...info });
  } catch (err) {
    console.error('extension check error:', err.message);
    res.status(500).json({ success: false, error: 'Could not check this product right now.' });
  }
});

/**
 * POST /api/extension/known
 * Body: { asins: string[] } (at most 100)
 * Free. For a page with many products (search results): what the user already has for each ASIN, in any store and state.
 */
router.post('/known', requireAuth, limiter, async (req, res) => {
  try {
    const asins = Array.isArray(req.body && req.body.asins) ? req.body.asins.slice(0, extension.MAX_KNOWN_ASINS).map((a) => text(a, 16)) : [];
    res.json({ success: true, known: await extension.knownFor(req.userId, asins) });
  } catch (err) {
    console.error('extension known error:', err.message);
    res.status(500).json({ success: false, error: 'Could not check these products right now.' });
  }
});

module.exports = router;
