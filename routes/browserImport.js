const express = require('express');
const router = express.Router();
const { createImport, updateImportImages } = require('../models/importsModel');
const { upsertDraft, findListingInStore } = require('../models/listingsModel');
const { hasCredits, getUserById } = require('../models/usersModel');
const { withCredits } = require('../services/creditService');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidAmazonUrl, assertAmazonMatchesStore } = require('../services/validationService');
const { storeForImport, alreadyListedMessage } = require('../services/extensionService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { materializeImageUrls } = require('../services/imageStorageService');
const { requireAsinSku } = require('../services/skuService');
const { currencyForAmazonUrl } = require('../config/amazonDomains');

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

const MAX_VARIANTS = 50;
const MAX_VARIANT_IMAGES = 12;

/**
 * The colour / size / ... variants the extension read: each with its own ASIN, title, pictures, price and what makes it
 * different (dimensions). Nothing is invented: a variant needs a real ASIN, and every field is cleaned like the product's own.
 */
function cleanVariants(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const asin = cleanText(v && v.asin, 32);
    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin) || seen.has(asin.toUpperCase())) continue;
    seen.add(asin.toUpperCase());
    const price = v.price == null || v.price === '' ? null : Number(v.price);
    const images = cleanImages(v.images).slice(0, MAX_VARIANT_IMAGES);
    const image = cleanImages([v.image])[0] || images[0] || null;
    out.push({
      asin: asin.toUpperCase(),
      title: cleanProductTitle(v.title) || cleanText(v.label, 200),
      label: cleanText(v.label, 200),
      image,
      images: images.length ? images : (image ? [image] : []),
      price: Number.isFinite(price) && price >= 0 ? price : null,
      availability: cleanText(v.availability, 200),
      isCurrentProduct: v.isCurrentProduct === true,
      dimensions: Array.isArray(v.dimensions)
        ? v.dimensions.map((d) => ({ name: cleanText(d && d.name, 80), value: cleanText(d && d.value, 200) })).filter((d) => d.name && d.value).slice(0, 8)
        : [],
    });
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

function cleanProduct(input, amazonUrl) {
  const variants = cleanVariants(input.variants);
  const price = input.price == null || input.price === '' ? null : Number(input.price);
  return {
    asin: cleanText(input.asin, 32),
    title: cleanProductTitle(input.title) || '',
    description: cleanDescription(input.description),
    bulletPoints: Array.isArray(input.bulletPoints) ? input.bulletPoints.map((x) => cleanText(x, 2000)).filter(Boolean).slice(0, 30) : [],
    images: cleanImages(input.images),
    price: Number.isFinite(price) && price >= 0 ? price : null,
    // The Amazon site decides the currency (the page's language or a default of USD gets AU, CA and EU sites wrong).
    currency: currencyForAmazonUrl(amazonUrl) || cleanText(input.currency, 8) || 'USD',
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
    variantDimensions: [...new Set(variants.flatMap((v) => v.dimensions.map((d) => d.name)))],
    sourceMarketplace: cleanText(input.sourceMarketplace, 200),
    specifications: Array.isArray(input.specifications)
      ? input.specifications.map((s) => ({ name: cleanText(s?.name, 300), value: cleanText(s?.value, 2000) })).filter((s) => s.name && s.value).slice(0, 100)
      : [],
    variants,
  };
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { amazonUrl, product, markupPercent, ebayAccountId } = req.body || {};

    if (!amazonUrl || !isValidAmazonUrl(amazonUrl)) {
      return res.status(400).json({ success: false, error: 'A valid Amazon product URL is required.' });
    }
    const activeEbayAccount = await storeForImport(req.userId, ebayAccountId);
    try {
      assertAmazonMatchesStore(amazonUrl, activeEbayAccount?.marketplaceId || null);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ success: false, error: err.message });
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

    const existing = await findListingInStore(req.userId, normalized.asin, activeEbayAccount?.id || null);
    const blocked = alreadyListedMessage(existing, activeEbayAccount);
    if (blocked) {
      return res.status(409).json({ success: false, code: 'already_listed', error: blocked, listing: { id: existing.id, status: existing.status } });
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

    let suggestedPrice = normalized.price;
    if (normalized.price != null && markupPercent != null && markupPercent !== '') {
      const markup = Number(markupPercent);
      if (Number.isFinite(markup) && markup >= -99 && markup <= 1000) {
        suggestedPrice = Number((normalized.price * (1 + markup / 100)).toFixed(2));
      }
    }

    let importRecord;
    let draft;
    // Pays first (nothing is saved without the credit) and gives it back if saving fails.
    await withCredits(req.userId, ACTION_COSTS.BROWSER_IMPORT_SCRAPE, async () => {
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
        description: normalized.description || '',
        bulletPoints: normalized.bulletPoints || [],
        specifications: normalized.specifications || [],
        ebayAspects: normalized.ebayAspects || {},
        amazonPrice: normalized.price,
        marginAmount: suggestedPrice != null && normalized.price != null ? Number((suggestedPrice - normalized.price).toFixed(2)) : null,
      });
    });

    // What is left, so the extension can show it (null: an admin has no limit). Never a reason to fail an import that worked.
    let creditsLeft = null;
    try {
      const after = await getUserById(req.userId);
      creditsLeft = after && after.role !== 'admin' ? after.creditBalance : null;
    } catch (_) { /* the import is saved either way */ }

    return res.json({
      success: true, source: 'browser', product: normalized, suggestedPrice, importId: importRecord.id, draft, creditsLeft,
      store: activeEbayAccount ? { id: activeEbayAccount.id, label: activeEbayAccount.label } : null,
      appUrl: require('../services/extensionService').frontendUrl(),
    });
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) console.error('browser-import error:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not import the product.' });
  }
});

module.exports = router;
module.exports.cleanProduct = cleanProduct;
module.exports.alreadyListedMessage = alreadyListedMessage;
