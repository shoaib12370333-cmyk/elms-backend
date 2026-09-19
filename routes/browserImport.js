const express = require('express');
const router = express.Router();
const { createImport, updateImportImages } = require('../models/importsModel');
const { upsertDraft } = require('../models/listingsModel');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidAmazonUrl } = require('../services/validationService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { materializeImageUrls } = require('../services/imageStorageService');
const { requireAsinSku } = require('../services/skuService');

const MAX_IMAGES = 24;
const MAX_TEXT = 20000;

function cleanText(value, max = MAX_TEXT) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanProductTitle(value) {
  let text = cleanText(value, 1000) || '';
  text = text
    .replace(/Product\s+summary\s+presents\s+key\s+product\s+information/ig, ' ')
    .replace(/Keyboard\s+shortcut\s+(?:shift\s*\+\s*){1,6}(?:alt\s*\+\s*)?(?:opt\s*\+\s*)?[a-z0-9]+/ig, ' ')
    .replace(/Keyboard\s+shortcut[^.\n]*/ig, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text || null;
}

function cleanDescription(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/Product\s+summary\s+presents\s+key\s+product\s+information/ig, ' ')
    .replace(/Keyboard\s+shortcut[^.\n]*/ig, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  return [...new Set(images.map((x) => String(x).trim()).filter((x) => /^https?:\/\//i.test(x)))].slice(0, MAX_IMAGES);
}

function cleanProduct(input, amazonUrl) {
  const price = input.price == null || input.price === '' ? null : Number(input.price);
  return {
    asin: cleanText(input.asin, 32),
    title: cleanProductTitle(input.title) || '',
    description: cleanDescription(input.description),
    bulletPoints: Array.isArray(input.bulletPoints) ? input.bulletPoints.map((x) => cleanText(x, 2000)).filter(Boolean).slice(0, 30) : [],
    images: cleanImages(input.images),
    price: Number.isFinite(price) && price >= 0 ? price : null,
    currency: cleanText(input.currency, 8) || 'USD',
    availability: cleanText(input.availability, 200),
    rating: input.rating == null ? null : (Number.isFinite(Number(input.rating)) ? Number(input.rating) : null),
    ratingsTotal: input.ratingsTotal == null ? null : cleanText(input.ratingsTotal, 40),
    bestSellersRank: cleanText(input.bestSellersRank, 2000),
    brand: cleanText(input.brand, 300),
    manufacturer: cleanText(input.manufacturer, 300),
    modelNumber: cleanText(input.modelNumber, 300),
    partNumber: cleanText(input.partNumber, 300),
    itemWeight: cleanText(input.itemWeight, 300),
    itemDimensions: cleanText(input.itemDimensions, 500),
    countryOfOrigin: cleanText(input.countryOfOrigin, 200),
    department: cleanText(input.department, 200),
    dateFirstAvailable: cleanText(input.dateFirstAvailable, 100),
    upc: cleanText(input.upc, 100),
    ean: cleanText(input.ean, 100),
    isbn: cleanText(input.isbn, 100),
    warranty: cleanText(input.warranty, 1000),
    color: cleanText(input.color, 200),
    material: cleanText(input.material, 300),
    size: cleanText(input.size, 200),
    categoryPath: cleanText(input.categoryPath, 2000),
    sourceUrl: amazonUrl,
    categories: Array.isArray(input.categories) ? input.categories.map((x) => cleanText(x, 300)).filter(Boolean).slice(0, 30) : [],
    productInformation: input.productInformation && typeof input.productInformation === 'object' ? Object.fromEntries(Object.entries(input.productInformation).slice(0, 50).map(([k,v]) => [cleanText(k,100), cleanText(v,2000)]).filter(([k,v]) => k && v)) : {},
    aplusContent: input.aplusContent && typeof input.aplusContent === 'object' ? { text: cleanText(input.aplusContent.text, 30000), images: cleanImages(input.aplusContent.images) } : { text: null, images: [] },
    variantDimensions: [],
    sourceMarketplace: cleanText(input.sourceMarketplace, 200),
    specifications: Array.isArray(input.specifications)
      ? input.specifications.map((s) => ({ name: cleanText(s?.name, 300), value: cleanText(s?.value, 2000) })).filter((s) => s.name && s.value).slice(0, 100)
      : [],
    variants: [],
  };
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { amazonUrl, product, markupPercent } = req.body || {};

    if (!amazonUrl || !isValidAmazonUrl(amazonUrl)) {
      return res.status(400).json({ success: false, error: 'A valid Amazon product URL is required.' });
    }
    if (!product || typeof product !== 'object') {
      return res.status(400).json({ success: false, error: 'Product data is required.' });
    }

    const normalized = cleanProduct(product, amazonUrl.trim());
    if (!normalized.asin) {
      return res.status(400).json({ success: false, error: 'Could not detect the product ASIN on the current page.' });
    }
    if (!normalized.title) {
      return res.status(400).json({ success: false, error: 'Could not detect the product title on the current page.' });
    }

    // A browser-extension (floating-button) import is billed under its own
    // key, ACTION_COSTS.BROWSER_IMPORT_SCRAPE, even though it doesn't call
    // Canopy - it still saves the user from pasting the link on the
    // website themselves, and keeps the "every import costs something"
    // rule consistent. It's a separate key from AMAZON_IMPORT (rather than
    // sharing it) specifically so this Canopy-free path can be priced
    // differently from the Canopy-backed one in the Admin Panel.
    if (!(await hasCredits(req.userId, ACTION_COSTS.BROWSER_IMPORT_SCRAPE))) {
      return res.status(402).json({
        success: false,
        error: 'You have run out of credits. Please open a support ticket to request more.',
      });
    }

    const activeEbayAccount = await getActiveEbayAccount(req.userId);
    let suggestedPrice = normalized.price;
    if (normalized.price != null && markupPercent != null && markupPercent !== '') {
      const markup = Number(markupPercent);
      if (Number.isFinite(markup) && markup >= -99 && markup <= 1000) {
        suggestedPrice = Number((normalized.price * (1 + markup / 100)).toFixed(2));
      }
    }

    const charged = await spendCredit(req.userId, ACTION_COSTS.BROWSER_IMPORT_SCRAPE);

    let importRecord;
    let draft;
    try {
      importRecord = await createImport(req.userId, normalized, suggestedPrice, amazonUrl.trim(), activeEbayAccount?.id || null);
      const storedImages = normalized.images.length
        ? await materializeImageUrls({ urls: normalized.images, userId: req.userId, listingId: importRecord.id, req })
        : [];
      normalized.images = storedImages;
      await updateImportImages(req.userId, importRecord.id, storedImages);
      const sku = requireAsinSku(normalized.asin, 'Amazon product');
      draft = await upsertDraft(req.userId, {
        importId: importRecord.id,
        ebayAccountId: activeEbayAccount?.id || null,
        marketplaceId: activeEbayAccount?.marketplaceId || null,
        sku,
        title: normalized.title,
        mainImage: storedImages[0] || null,
        images: storedImages,
        sellPrice: suggestedPrice,
        markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
        currency: normalized.currency,
        quantity: 1,
        categoryId: null,
        amazonPrice: normalized.price,
        marginAmount: suggestedPrice != null && normalized.price != null ? Number((suggestedPrice - normalized.price).toFixed(2)) : null,
      });
    } catch (err) {
      // We already have the product data (the part credits actually pay
      // for), but saving it failed - refund so the user isn't charged for
      // a draft they never actually got. Mirrors routes/fetchProduct.js.
      if (charged) await refundCredit(req.userId, ACTION_COSTS.BROWSER_IMPORT_SCRAPE);
      throw err;
    }

    return res.json({ success: true, source: 'browser', product: normalized, suggestedPrice, importId: importRecord.id, draft });
  } catch (err) {
    console.error('browser-import error:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not import the product.' });
  }
});

module.exports = router;
