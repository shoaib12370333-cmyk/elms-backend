const Import = require('./schemas/Import');

/**
 * Saves a fetched Amazon product as an import record, belonging to a specific user.
 * @param {string} userId
 * @param {object} product - normalized product object (from canopyAmazonService or browser extraction)
 * @param {number|null} suggestedPrice
 * @param {string} amazonUrl - original URL the user pasted (may be null for variant fetches)
 * @returns {object} the created import document
 */
async function createImport(userId, product, suggestedPrice, amazonUrl) {
  const doc = await Import.create({
    userId,
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
    .filter((url) => /^https?:\/\//i.test(url)))).slice(0, 50);
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

async function listImports(userId, limit = 50) {
  const docs = await Import.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  return docs.map(serialize);
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

module.exports = { createImport, getImportById, listImports, updateImportImages, updateImportProduct, updateImportPrice };
