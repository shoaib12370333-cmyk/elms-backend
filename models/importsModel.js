const Import = require('./schemas/Import');

/**
 * Saves a fetched Amazon product as an import record, belonging to a specific user.
 * @param {string} userId
 * @param {object} product - normalized product object (from canopyAmazonService or browser extraction)
 * @param {number|null} suggestedPrice
 * @param {string} amazonUrl - original URL the user pasted (may be null for variant fetches)
 * @returns {object} the created import document
 */
async function createImport(userId, product, suggestedPrice, amazonUrl, ebayAccountId = null) {
  const doc = await Import.create({
    userId,
    ebayAccountId: ebayAccountId || null,
    sourcePlatform: 'amazon',
    asin: product.asin || null,
    title: product.title || null,
    amazonUrl: amazonUrl || null,
    amazonPrice: product.price ?? null,
    currency: product.currency || 'USD',
    mainImage: (product.images && product.images[0]) || null,
    product,
    suggestedPrice: suggestedPrice ?? null,
  });

  return serialize(doc);
}

/**
 * Saves a fetched CJdropshipping product+variant as an import record (services/cjImportService.js). Never shares a field with
 * createImport above: asin stays null, amazonUrl stays null, and the CJ ids live in their own columns (models/schemas/Import.js).
 * @param {object} product - normalized product object (services/cjImportService.js normalizeCjProduct), with cjProductId/cjVariantId set
 */
async function createCjImport(userId, product, suggestedPrice, ebayAccountId = null) {
  const doc = await Import.create({
    userId,
    ebayAccountId: ebayAccountId || null,
    sourcePlatform: 'cj',
    cjProductId: product.cjProductId,
    cjVariantId: product.cjVariantId,
    title: product.title || null,
    amazonPrice: product.price ?? null, // the CJ variant's own price (before CJ shipping); the shared "source price" field
    currency: product.currency || 'USD',
    mainImage: (product.images && product.images[0]) || null,
    product,
    suggestedPrice: suggestedPrice ?? null,
  });

  return serialize(doc);
}

/**
 * Saves a fetched AliExpress product+sku as an import record (services/aliexpressImportService.js). Never shares a field
 * with createImport/createCjImport above: asin/amazonUrl/cjProductId/cjVariantId stay null, and the AliExpress ids live in
 * their own columns (models/schemas/Import.js).
 * @param {object} product - normalized product object (services/aliexpressImportService.js normalizeAliexpressProduct), with aliexpressProductId/aliexpressSkuId set
 */
async function createAliexpressImport(userId, product, suggestedPrice, ebayAccountId = null) {
  const doc = await Import.create({
    userId,
    ebayAccountId: ebayAccountId || null,
    sourcePlatform: 'aliexpress',
    aliexpressProductId: product.aliexpressProductId,
    aliexpressSkuId: product.aliexpressSkuId,
    title: product.title || null,
    amazonPrice: product.price ?? null, // the AliExpress sku's own price - the shared "source price" field
    currency: product.currency || 'USD',
    mainImage: (product.images && product.images[0]) || null,
    product,
    suggestedPrice: suggestedPrice ?? null,
  });

  return serialize(doc);
}

/**
 * Gets an import by ID, but only if it belongs to the given user.
 */
async function getImportById(userId, id) {
  const doc = await Import.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

async function updateImportProduct(userId, id, product) {
  if (!product || typeof product !== 'object') return null;
  const doc = await Import.findOneAndUpdate(
    { _id: id, userId },
    {
      $set: {
        title: product.title || null,
        'product.title': product.title || null,
        'product.bulletPoints': Array.isArray(product.bulletPoints) ? product.bulletPoints : [],
        'product.description': product.description || '',
        'product.specifications': Array.isArray(product.specifications) ? product.specifications : [],
        'product.ebayAspects': product.ebayAspects && typeof product.ebayAspects === 'object' ? product.ebayAspects : {},
      },
    },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function updateImportImages(userId, id, images) {
  const cleanImages = Array.from(new Set((Array.isArray(images) ? images : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url)))).slice(0, 24);
  const doc = await Import.findOneAndUpdate(
    { _id: id, userId },
    { $set: { 'product.images': cleanImages, mainImage: cleanImages[0] || null } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Records a freshly-observed Amazon price for an import, used by the price
 * monitor after each check so the next check has an up-to-date baseline to
 * compare against (regardless of whether the eBay price actually changed).
 */
async function updateImportPrice(userId, id, amazonPrice) {
  const doc = await Import.findOneAndUpdate(
    { _id: id, userId },
    { $set: { amazonPrice } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Converts a Mongoose document into the plain shape the rest of the app expects
 * (matching the old SQLite column names, e.g. main_image instead of mainImage,
 * and id as a string instead of Mongo's _id).
 */
function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    source_platform: obj.sourcePlatform || 'amazon',
    cj_product_id: obj.cjProductId || null,
    cj_variant_id: obj.cjVariantId || null,
    aliexpress_product_id: obj.aliexpressProductId || null,
    aliexpress_sku_id: obj.aliexpressSkuId || null,
    asin: obj.asin,
    title: obj.title,
    amazon_url: obj.amazonUrl,
    amazon_price: obj.amazonPrice,
    currency: obj.currency,
    main_image: obj.mainImage,
    product: obj.product,
    suggested_price: obj.suggestedPrice,
    created_at: obj.createdAt,
  };
}

module.exports = { createImport, createCjImport, createAliexpressImport, getImportById, updateImportImages, updateImportProduct, updateImportPrice };
