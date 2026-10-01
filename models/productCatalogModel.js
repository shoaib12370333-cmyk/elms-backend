const ProductCatalogItem = require('./schemas/ProductCatalogItem');
const { createImport, updateImportImages } = require('./importsModel');
const { upsertDraft, findListingInStore } = require('./listingsModel');
const { getActiveEbayAccount } = require('./ebayAccountsModel');
const { alreadyListedMessage } = require('../services/extensionService');
const { requireAsinSku } = require('../services/skuService');
const { priceByRule } = require('../services/importPricingService');
const { mapPool } = require('../services/bulkEditService');

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

function serialize(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id.toString(),
    asin: obj.asin,
    amazonUrl: obj.amazonUrl || null,
    country: obj.country,
    marketplaceId: obj.marketplaceId,
    title: obj.title,
    description: obj.description || '',
    bulletPoints: Array.isArray(obj.bulletPoints) ? obj.bulletPoints : [],
    images: Array.isArray(obj.images) ? obj.images : [],
    mainImage: (obj.images && obj.images[0]) || null,
    price: obj.price,
    currency: obj.currency || 'USD',
    brand: obj.brand || null,
    specifications: Array.isArray(obj.specifications) ? obj.specifications : [],
    categoryId: obj.categoryId || null,
    categoryName: obj.categoryName || null,
    categoryError: obj.categoryError || null,
    expiresAt: obj.expiresAt,
    createdAt: obj.createdAt,
  };
}

/** Saves one successfully-fetched Easyparser product (normalizeDetail shape) as a catalog row. Taxonomy is whatever the caller already resolved (or null - see jobs/adminCatalogProcessor.js, which tries AI category pick but never lets that failure stop the row from being saved). */
async function createCatalogItem({ createdBy, product, amazonUrl, country, marketplaceId, categoryId = null, categoryName = null, categoryError = null, expiresAt }) {
  const doc = await ProductCatalogItem.create({
    createdBy,
    asin: product.asin,
    amazonUrl: amazonUrl || null,
    country,
    marketplaceId,
    title: product.title || null,
    description: product.description || '',
    bulletPoints: Array.isArray(product.bulletPoints) ? product.bulletPoints : [],
    images: Array.isArray(product.images) ? product.images : [],
    price: product.price ?? null,
    currency: product.currency || 'USD',
    brand: product.brand || null,
    specifications: Array.isArray(product.specifications) ? product.specifications : [],
    categoryId,
    categoryName,
    categoryError,
    expiresAt,
  });
  return serialize(doc);
}

/** Newest first, paginated - the Admin Panel's Product Catalog table. marketplaceId narrows to one eBay site's section (the table is split by marketplace there, since a pushed category only ever carries over within the same one - see pushCatalogItemToUserDrafts). */
async function listCatalogItems({ page = 1, limit = PAGE_DEFAULT, marketplaceId } = {}) {
  const p = Math.max(1, Math.trunc(Number(page)) || 1);
  const l = Math.min(PAGE_MAX, Math.max(1, Math.trunc(Number(limit)) || PAGE_DEFAULT));
  const query = marketplaceId ? { marketplaceId } : {};
  const [rows, total] = await Promise.all([
    ProductCatalogItem.find(query).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    ProductCatalogItem.countDocuments(query),
  ]);
  return { items: rows.map(serialize), total, page: p, pages: Math.max(1, Math.ceil(total / l)) };
}

/** How many catalog rows exist per eBay marketplace, for the Admin Panel's per-marketplace sections. */
async function listMarketplaceCounts() {
  const rows = await ProductCatalogItem.aggregate([
    { $group: { _id: '$marketplaceId', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ marketplaceId: r._id, count: r.count }));
}

async function getCatalogItemById(id) {
  const doc = await ProductCatalogItem.findById(id).lean();
  return doc ? serialize(doc) : null;
}

async function deleteCatalogItem(id) {
  const res = await ProductCatalogItem.deleteOne({ _id: id });
  return res.deletedCount > 0;
}

/** jobs/catalogExpiry.js: rows whose time is up, whether or not they were ever pushed to a seller. @returns {Promise<number>} how many were removed */
async function deleteExpiredCatalogItems(now = new Date()) {
  const res = await ProductCatalogItem.deleteMany({ expiresAt: { $lte: now } });
  return res.deletedCount || 0;
}

/**
 * Pushes one catalog row into targetUserId's Drafts - free (no credit charge, same as services/listingCloneService.js's
 * admin "push listings" tool), and the row itself is left untouched so it can be pushed to other sellers too, or again,
 * until it expires. The category only carries over when it was resolved for the SAME eBay marketplace the target
 * seller's active store is on (an eBay category tree is marketplace-specific - a US category id is not a valid UK one);
 * otherwise the draft is still created, just uncategorized, exactly like a fresh Amazon import with no category yet.
 * @returns {Promise<{ draft: object, categoryCarried: boolean }>}
 * @throws Error with .statusCode 409 (already has this ASIN in that store) or whatever upsertDraft/priceByRule throw
 */
async function pushCatalogItemToUserDrafts(catalogItemId, targetUserId) {
  const item = await ProductCatalogItem.findById(catalogItemId).lean();
  if (!item) { const e = new Error('Catalog item not found.'); e.statusCode = 404; throw e; }

  const activeEbayAccount = await getActiveEbayAccount(targetUserId);
  const already = alreadyListedMessage(await findListingInStore(targetUserId, item.asin, activeEbayAccount?.id || null), activeEbayAccount);
  if (already) { const e = new Error(already); e.statusCode = 409; e.alreadyListed = true; throw e; }

  const categoryCarried = !!item.categoryId && !!activeEbayAccount?.marketplaceId && item.marketplaceId === activeEbayAccount.marketplaceId;

  const ruled = await priceByRule({ userId: targetUserId, price: item.price, currency: item.currency, markupPercent: null, pricingRule: undefined });
  const sellPrice = ruled ? ruled.sellPrice : item.price;

  const images = (item.images || []).slice(0, 24);
  const importRecord = await createImport(
    targetUserId,
    { asin: item.asin, title: item.title, price: item.price, currency: item.currency, images },
    sellPrice,
    item.amazonUrl,
    activeEbayAccount?.id || null
  );
  if (images.length) await updateImportImages(targetUserId, importRecord.id, images);

  const draft = await upsertDraft(targetUserId, {
    importId: importRecord.id,
    ebayAccountId: activeEbayAccount?.id || null,
    marketplaceId: activeEbayAccount?.marketplaceId || null,
    sku: requireAsinSku(item.asin, 'catalog product'),
    amazonUrl: item.amazonUrl,
    title: item.title,
    mainImage: images[0] || null,
    images,
    sellPrice,
    markupPercent: ruled ? ruled.markupPercent : 0,
    currency: item.currency,
    quantity: 1,
    categoryId: categoryCarried ? item.categoryId : null,
    description: item.description || '',
    bulletPoints: item.bulletPoints || [],
    specifications: item.specifications || [],
    ebayAspects: {}, // the catalog never stores resolved item specifics (only the category id/name) - Fill specifics with AI picks them up same as any fresh import
    amazonPrice: item.price,
    marginAmount: ruled ? ruled.marginAmount : null,
    pricingRule: ruled ? ruled.pricingRule : null,
  });
  return { draft, categoryCarried };
}

/**
 * The bulk form of pushCatalogItemToUserDrafts above: an admin selects several rows (typically a whole marketplace
 * section, or "select all") and pushes them to one chosen seller at once. Each row is independent - one the seller
 * already owns is skipped, not an error for the whole batch, so "push everything, skip what they already have" is
 * one action instead of pushing one at a time and hitting a 409 on each duplicate.
 * @returns {Promise<{ results: Array<{id, status:'pushed'|'already_have'|'not_found'|'failed', reason?, draftId?, categoryCarried?}>, summary: {pushed, alreadyHave, failed, notFound} }>}
 */
async function pushCatalogItemsToUserDrafts(catalogItemIds, targetUserId) {
  const results = await mapPool(catalogItemIds, 5, async (id) => {
    try {
      const { draft, categoryCarried } = await pushCatalogItemToUserDrafts(id, targetUserId);
      return { id, status: 'pushed', draftId: draft.id, categoryCarried };
    } catch (err) {
      if (err.statusCode === 404) return { id, status: 'not_found', reason: err.message };
      if (err.alreadyListed) return { id, status: 'already_have', reason: err.message };
      return { id, status: 'failed', reason: err.message || 'Could not push this product.' };
    }
  });
  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { pushed: count('pushed'), alreadyHave: count('already_have'), failed: count('failed'), notFound: count('not_found') } };
}

module.exports = { createCatalogItem, listCatalogItems, listMarketplaceCounts, getCatalogItemById, deleteCatalogItem, deleteExpiredCatalogItems, pushCatalogItemToUserDrafts, pushCatalogItemsToUserDrafts };
