const Import = require('./schemas/Import');

/**
 * Saves a fetched Amazon product as an import record, belonging to a specific user.
 * @param {string} userId
 * @param {object} product - normalized product object (from rapidAmazonService)
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

module.exports = { createImport, getImportById, listImports };
