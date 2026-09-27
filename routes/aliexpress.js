const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const aliexpressAdapter = require('../services/aliexpressAdapter');
const { extractAliexpressProductId, listSkus, fetchAndSaveAliexpressDraft, destCountryFor } = require('../services/aliexpressImportService');
const { hasCredits } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { assertStoreForImport } = require('../services/extensionService');

/**
 * AliExpress - a third, separate product source next to Amazon and CJ. Every route here talks to AliExpress's API only
 * (services/aliexpressAdapter.js); nothing here calls Canopy, Easyparser, or CJ. See models/schemas/Listing.js for the
 * "never mix" rule this whole feature follows. Account connection lives in routes/aliexpressConnect.js, not here.
 */

/**
 * GET /api/aliexpress/product?url=  (or productId=)
 * One AliExpress product's full detail, every sku included - used by the Import page to let the seller pick an option
 * (colour/size ...) before importing it, and by "Import by URL/ID" when the id alone does not pick one sku.
 */
router.get('/product', requireAuth, async (req, res) => {
  const productId = extractAliexpressProductId(req.query.productId || req.query.url);
  if (!productId) return res.status(400).json({ success: false, error: 'Could not find an AliExpress product id in that link.' });
  try {
    let chosenStore;
    try { chosenStore = await getActiveEbayAccount(req.userId); } catch { chosenStore = null; }
    const detail = await aliexpressAdapter.getProductDetail(req.userId, { productId, shipToCountry: destCountryFor(chosenStore?.marketplaceId) });
    const base = detail.ae_item_base_info_dto || {};
    res.json({
      success: true,
      product: {
        aliexpressProductId: productId,
        title: base.subject || null,
        image: String(detail.ae_multimedia_info_dto?.image_urls || '').split(';')[0]?.trim() || null,
        description: base.detail || base.mobile_detail || '',
        skus: listSkus(detail),
      },
    });
  } catch (err) {
    console.error('aliexpress product error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load that AliExpress product.' });
  }
});

/**
 * POST /api/aliexpress/import  { productId | url, skuId?, markupPercent? }
 * Imports one AliExpress product/sku as a draft (the AliExpress counterpart of POST /api/fetch-product and POST /api/cj/
 * import). Costs ACTION_COSTS.ALIEXPRESS_IMPORT - never AMAZON_IMPORT/CJ_IMPORT. When the product has several skus and none
 * was picked (skuId missing), answers 400 with the sku list so the seller can choose, without charging anything.
 */
router.post('/import', requireAuth, async (req, res) => {
  const { skuId, markupPercent } = req.body || {};
  const productId = extractAliexpressProductId(req.body?.productId || req.body?.url);
  if (!productId) return res.status(400).json({ success: false, error: 'Could not find an AliExpress product id in that link.' });
  if (!(await hasCredits(req.userId, ACTION_COSTS.ALIEXPRESS_IMPORT))) {
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
    const result = await fetchAndSaveAliexpressDraft(req.userId, { productId, skuId }, markupPercent, req, chosenStore);
    res.json({ success: true, ...result });
  } catch (err) {
    if (!err.outOfCredits) console.error('aliexpress import error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not import that AliExpress product.', skus: err.skus });
  }
});

module.exports = router;
