const express = require('express');
const router = express.Router();
const { publishListing } = require('../services/ebayListingService');
const {
  createListing,
  updateListing,
  markPublished,
  markError,
} = require('../models/listingsModel');
const { getEbayRefreshToken, getSellerSettings } = require('../models/usersModel');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * POST /api/list-on-ebay
 * Requires a valid session token.
 * Body: {
 *   product: object, sellPrice: number, quantity?: number, categoryId: string,
 *   sku?: string, importId?: string
 * }
 *
 * Publishes an Amazon product (previously fetched) as a live eBay listing,
 * using the current user's connected eBay account.
 * A listing row is created first as a draft, then updated to "published"
 * or "error" depending on the outcome, so it shows up in Live Listings either way.
 */
router.post('/', requireAuth, async (req, res) => {
  const { product, sellPrice, quantity, categoryId, sku, importId } = req.body;
  const userId = req.userId;

  if (!product) {
    return res.status(400).json({ success: false, error: 'Product data is required.' });
  }
  if (!sellPrice) {
    return res.status(400).json({ success: false, error: 'A sellPrice is required.' });
  }
  if (!categoryId) {
    return res.status(400).json({ success: false, error: 'A categoryId is required.' });
  }

  const refreshToken = await getEbayRefreshToken(userId);
  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Please connect your eBay account before publishing a listing.',
    });
  }

  const sellerSettings = await getSellerSettings(userId);

  const finalSku = sku || `AMZ-${product.asin || Date.now()}`;
  const mainImage = (product.images && product.images[0]) || null;

  const listingRow = await createListing(userId, {
    importId: importId || null,
    sku: finalSku,
    title: product.title,
    mainImage,
    sellPrice,
    quantity: quantity || 1,
    categoryId,
  });

  try {
    const result = await publishListing({
      refreshToken,
      product,
      sellPrice,
      quantity,
      categoryId,
      sku: finalSku,
      sellerSettings,
    });

    const updatedRow = await markPublished(userId, listingRow.id, {
      offerId: result.offerId,
      listingId: result.listingId,
    });

    res.json({ success: true, ...result, listing: updatedRow });
  } catch (err) {
    console.error('list-on-ebay error:', err.message);
    const updatedRow = await markError(userId, listingRow.id, err.message);

    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not publish this listing to eBay.',
      ebayErrors: err.ebayErrors || null,
      listing: updatedRow,
    });
  }
});

/**
 * PUT /api/list-on-ebay/:id
 * Requires a valid session token.
 * Body: any of { title, mainImage, sellPrice, quantity, categoryId }
 *
 * Edits a draft (or previously errored) listing's fields before re-publishing.
 * Only works on listings owned by the current user.
 */
router.put('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title, mainImage, sellPrice, quantity, categoryId } = req.body;

  const updated = await updateListing(req.userId, id, { title, mainImage, sellPrice, quantity, categoryId });

  if (!updated) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  res.json({ success: true, listing: updated });
});

module.exports = router;
