const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const cjAdapter = require('../services/cjAdapter');
const { fetchAndSaveCjDraft } = require('../services/cjImportService');
const { isCjConnected, hasCredits } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { assertStoreForImport } = require('../services/extensionService');

/**
 * CJdropshipping - a second, separate product source next to Amazon. Every route here talks to CJ's API only (services/
 * cjAdapter.js); nothing here calls Canopy, Easyparser, or touches an Amazon field. See models/schemas/Listing.js for the
 * "never mix" rule this whole feature follows.
 */

/** GET /api/cj/status - whether this account has a CJ connection (never the key or a token). */
router.get('/status', requireAuth, async (req, res) => {
  const status = await isCjConnected(req.userId);
  res.json({ success: true, ...status });
});

/**
 * POST /api/cj/connect  { apiKey }
 * Validates the key by asking CJ for a token (so a typo or a revoked key fails here, not on the first import), then stores it
 * and the tokens, encrypted (services/cryptoService).
 */
router.post('/connect', requireAuth, async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) return res.status(400).json({ success: false, error: 'Enter your CJdropshipping API key.' });
  try {
    await cjAdapter.connect(req.userId, apiKey);
    res.json({ success: true, connected: true });
  } catch (err) {
    console.error('cj connect error:', err.message);
    res.status(err.statusCode || 400).json({ success: false, error: err.message || 'Could not connect to CJdropshipping with that key.' });
  }
});

/** POST /api/cj/disconnect - forgets this account's CJ key and tokens (best-effort logout with CJ first). */
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    await cjAdapter.disconnect(req.userId);
    res.json({ success: true, connected: false });
  } catch (err) {
    console.error('cj disconnect error:', err.message);
    res.status(500).json({ success: false, error: 'Could not disconnect CJdropshipping.' });
  }
});

/**
 * GET /api/cj/search?keyword=&categoryId=&page=&size=
 * "Find products on CJ" - a keyword/category search of the CJ catalog. Requires CJ to already be connected.
 */
router.get('/search', requireAuth, async (req, res) => {
  try {
    const result = await cjAdapter.searchProducts(req.userId, {
      keyword: req.query.keyword,
      categoryId: req.query.categoryId || null,
      page: req.query.page,
      size: req.query.size,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('cj search error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not search CJdropshipping.' });
  }
});

/**
 * GET /api/cj/product?pid=  (or productSku=, variantSku=)
 * One CJ product's full detail, every variant included - used by the Import page to let the seller pick a variant (colour/
 * size ...) before importing it, and by "Import by URL/ID" when the id alone does not pick one variant.
 */
router.get('/product', requireAuth, async (req, res) => {
  try {
    const detail = await cjAdapter.getProductDetail(req.userId, {
      pid: req.query.pid || null,
      productSku: req.query.productSku || null,
      variantSku: req.query.variantSku || null,
    });
    res.json({
      success: true,
      product: {
        cjProductId: detail.pid,
        title: detail.productNameEn,
        image: detail.bigImage,
        description: detail.description || '',
        variants: (detail.variants || []).map((v) => ({
          vid: v.vid,
          variantSku: v.variantSku,
          variantKey: v.variantKey,
          image: v.variantImage || detail.bigImage,
          price: Number(v.variantSellPrice) || null,
          inventory: (v.inventories || []).reduce((sum, i) => sum + (Number(i.totalInventory) || 0), 0),
        })),
      },
    });
  } catch (err) {
    console.error('cj product error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load that CJ product.' });
  }
});

/**
 * POST /api/cj/import  { pid | productSku | variantSku, vid?, markupPercent? }
 * Imports one CJ product/variant as a draft (the CJ counterpart of POST /api/fetch-product). Costs ACTION_COSTS.CJ_IMPORT -
 * never AMAZON_IMPORT. When the product has several variants and none was picked (vid missing), answers 400 with the variant
 * list so the seller can choose, without charging anything.
 */
router.post('/import', requireAuth, async (req, res) => {
  const { pid, productSku, variantSku, vid, markupPercent } = req.body || {};
  if (!pid && !productSku && !variantSku) {
    return res.status(400).json({ success: false, error: 'A CJ product id, product SKU or variant SKU is required.' });
  }
  if (!(await hasCredits(req.userId, ACTION_COSTS.CJ_IMPORT))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }
  let chosenStore;
  try {
    chosenStore = await getActiveEbayAccount(req.userId);
    await assertStoreForImport(chosenStore);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
  try {
    const result = await fetchAndSaveCjDraft(req.userId, { pid, productSku, variantSku, vid }, markupPercent, req, chosenStore);
    res.json({ success: true, ...result });
  } catch (err) {
    if (!err.outOfCredits) console.error('cj import error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not import that CJ product.', variants: err.variants });
  }
});

module.exports = router;
