const mongoose = require('mongoose');
const Listing = require('./schemas/Listing');
const EbayAccount = require('./schemas/EbayAccount');
const { normalizeAsinSku, requireAsinSku } = require('../services/skuService');
const { accountLabel, publicUsername } = require('../services/accountLabel');
const { isMissingLocalImage } = require('../services/imageStorageService');

// Amazon product prices are positive monetary values. Treat null/undefined/empty
// values (and the legacy 0 created by Number(null)) as missing so the UI can
// fall back to the saved Import price instead of showing $0.00.
function normalizeAmazonPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Creates a new draft listing (before it's published to eBay), for a specific user.
 */
async function createListing(userId, { importId, ebayAccountId, marketplaceId, sku, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount, repricingEnabled, pricingRule }) {
  const normalizedAmazonPrice = normalizeAmazonPrice(amazonPrice);
  const normalizedSku = requireAsinSku(sku, 'listing');
  const doc = await Listing.create({
    userId,
    importId: importId || null,
    sourcePlatform: 'amazon',
    ebayAccountId: ebayAccountId || null,
    marketplaceId: marketplaceId || null,
    sku: normalizedSku,
    title: title || null,
    mainImage: mainImage || null,
    images: Array.isArray(images) ? images.slice(0, 24) : [],
    sellPrice: sellPrice ?? null,
    amazonPrice: normalizedAmazonPrice,
    marginAmount: Number.isFinite(Number(marginAmount))
      ? Number(marginAmount)
      : (Number.isFinite(Number(sellPrice)) && normalizedAmazonPrice !== null
        ? Number((Number(sellPrice) - normalizedAmazonPrice).toFixed(2))
        : null),
    repricingEnabled: repricingEnabled !== false,
    pricingRule: pricingRule && typeof pricingRule === 'object' ? pricingRule : null,
    description: typeof description === 'string' ? description : '',
    bulletPoints: Array.isArray(bulletPoints) ? bulletPoints.map((v) => String(v ?? '').trim()).filter(Boolean) : [],
    specifications: Array.isArray(specifications) ? specifications : [],
    ebayAspects: ebayAspects && typeof ebayAspects === 'object' ? ebayAspects : {},
    markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
    currency: currency || 'USD',
    quantity: quantity ?? 1,
    categoryId: categoryId || null,
    status: 'draft',
  });
  return serialize(doc);
}

/**
 * Creates or updates a draft listing for the given user, keyed by SKU
 * (which is derived from the Amazon ASIN, e.g. "B0GZWQ8JML"). This is
 * called automatically every time a product is fetched, so re-fetching the
 * same Amazon product refreshes its existing draft instead of creating a
 * duplicate. Only listings still in "draft" status are touched this way -
 * if the user has already published, errored, or ended this SKU, re-fetching
 * the same product does NOT overwrite that listing's status or eBay IDs.
 */
async function upsertDraft(userId, { importId, ebayAccountId, marketplaceId, sku, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount, pricingRule }) {
  const normalizedSku = requireAsinSku(sku, 'draft');
  // The same Amazon product can live as a separate draft in each connected store,
  // so a listing is identified by (user, store, sku). A legacy listing with no
  // store is adopted by the first store that fetches the product again.
  const accountKey = ebayAccountId || null;
  const existing = (await Listing.findOne({ userId, sku: normalizedSku, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sku: normalizedSku, ebayAccountId: null }) : null);

  if (existing && existing.status !== 'draft') {
    // Don't silently touch a listing that's already live/errored/ended -
    // just return it as-is so the caller knows a non-draft version exists.
    return serialize(existing);
  }

  const sellerEdited = !!existing?.draftCustomized;
  const normalizedAmazonPrice = normalizeAmazonPrice(amazonPrice);
  const update = {
      userId,
      importId: importId || null,
      sourcePlatform: 'amazon', // explicit, not left to the schema's upsert default - see models/schemas/Listing.js
      sku: normalizedSku,
      ...(sellerEdited ? {} : {
        title: title || null,
        mainImage: mainImage || null,
        sellPrice: sellPrice ?? null,
        pricingRule: pricingRule && typeof pricingRule === 'object' ? pricingRule : null,
        description: typeof description === 'string' ? description : '',
        bulletPoints: Array.isArray(bulletPoints) ? bulletPoints.map((v) => String(v ?? '').trim()).filter(Boolean) : [],
        specifications: Array.isArray(specifications) ? specifications : [],
        ebayAspects: ebayAspects && typeof ebayAspects === 'object' ? ebayAspects : {},
        markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
        currency: currency || 'USD',
        quantity: quantity ?? 1,
        categoryId: categoryId || null,
        amazonPrice: normalizedAmazonPrice,
        marginAmount: Number.isFinite(Number(marginAmount)) ? Number(marginAmount) : (Number.isFinite(Number(sellPrice)) && normalizedAmazonPrice !== null ? Number((Number(sellPrice) - normalizedAmazonPrice).toFixed(2)) : null),
      }),
      status: 'draft',
    };
  if (sellerEdited && normalizedAmazonPrice !== null) update.amazonPrice = normalizedAmazonPrice;
    if (ebayAccountId !== undefined && !existing?.ebayAccountId) update.ebayAccountId = ebayAccountId || null;
    if (marketplaceId !== undefined && !existing?.marketplaceId) update.marketplaceId = marketplaceId || null;
    if (!existing || !Array.isArray(existing.images) || existing.images.length === 0) {
      update.images = Array.isArray(images) ? images.slice(0, 24) : [];
    }

  const doc = await Listing.findOneAndUpdate(
    existing ? { _id: existing._id } : { userId, sku: normalizedSku, ebayAccountId: accountKey },
    update,
    { new: true, upsert: true }
  );
  return serialize(doc);
}

/**
 * The CJdropshipping equivalent of upsertDraft above (services/cjImportService.js). Deliberately a separate function, not a
 * branch inside upsertDraft: it is found by cjProductId/cjVariantId (never by sku - findCjListingInStore), uses cjSkuFor
 * (built from cjVariantId, never the supplier's own variant sku text - see services/skuService.js) instead of requireAsinSku,
 * and sets sourcePlatform/cjProductId/cjVariantId/cjShippingCost, which upsertDraft never touches.
 */
async function upsertCjDraft(userId, { importId, ebayAccountId, marketplaceId, cjProductId, cjVariantId, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount, pricingRule, cjShippingCost }) {
  const { cjSkuFor } = require('../services/skuService');
  const normalizedSku = cjSkuFor(cjVariantId, 'CJ draft');
  const accountKey = ebayAccountId || null;
  const existing = (await Listing.findOne({ userId, sourcePlatform: 'cj', cjProductId, cjVariantId, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sourcePlatform: 'cj', cjProductId, cjVariantId, ebayAccountId: null }) : null);

  if (existing && existing.status !== 'draft') return serialize(existing);

  const sellerEdited = !!existing?.draftCustomized;
  const normalizedAmazonPrice = normalizeAmazonPrice(amazonPrice);
  const update = {
    userId,
    importId: importId || null,
    sourcePlatform: 'cj',
    cjProductId,
    cjVariantId,
    sku: normalizedSku,
    ...(sellerEdited ? {} : {
      title: title || null,
      mainImage: mainImage || null,
      sellPrice: sellPrice ?? null,
      pricingRule: pricingRule && typeof pricingRule === 'object' ? pricingRule : null,
      description: typeof description === 'string' ? description : '',
      bulletPoints: Array.isArray(bulletPoints) ? bulletPoints.map((v) => String(v ?? '').trim()).filter(Boolean) : [],
      specifications: Array.isArray(specifications) ? specifications : [],
      ebayAspects: ebayAspects && typeof ebayAspects === 'object' ? ebayAspects : {},
      markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
      currency: currency || 'USD',
      quantity: quantity ?? 1,
      categoryId: categoryId || null,
      amazonPrice: normalizedAmazonPrice,
      cjShippingCost: Number.isFinite(Number(cjShippingCost)) ? Number(cjShippingCost) : null,
      marginAmount: Number.isFinite(Number(marginAmount)) ? Number(marginAmount) : (Number.isFinite(Number(sellPrice)) && normalizedAmazonPrice !== null ? Number((Number(sellPrice) - normalizedAmazonPrice).toFixed(2)) : null),
    }),
    status: 'draft',
  };
  if (sellerEdited && normalizedAmazonPrice !== null) update.amazonPrice = normalizedAmazonPrice;
  if (ebayAccountId !== undefined && !existing?.ebayAccountId) update.ebayAccountId = ebayAccountId || null;
  if (marketplaceId !== undefined && !existing?.marketplaceId) update.marketplaceId = marketplaceId || null;
  if (!existing || !Array.isArray(existing.images) || existing.images.length === 0) {
    update.images = Array.isArray(images) ? images.slice(0, 24) : [];
  }

  const doc = await Listing.findOneAndUpdate(
    existing ? { _id: existing._id } : { userId, sourcePlatform: 'cj', cjProductId, cjVariantId, ebayAccountId: accountKey },
    update,
    { new: true, upsert: true }
  );
  return serialize(doc);
}

/**
 * The AliExpress equivalent of upsertCjDraft above (services/aliexpressImportService.js). Found by aliexpressProductId/
 * aliexpressSkuId (never by sku - findAliexpressListingInStore), uses aliSkuFor (built from the AliExpress sku's own id,
 * never the supplier's own sku text - see services/skuService.js) instead of requireAsinSku/cjSkuFor.
 */
async function upsertAliexpressDraft(userId, { importId, ebayAccountId, marketplaceId, aliexpressProductId, aliexpressSkuId, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount, pricingRule }) {
  const { aliSkuFor } = require('../services/skuService');
  const normalizedSku = aliSkuFor(aliexpressSkuId, 'AliExpress draft');
  const accountKey = ebayAccountId || null;
  const existing = (await Listing.findOne({ userId, sourcePlatform: 'aliexpress', aliexpressProductId, aliexpressSkuId, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sourcePlatform: 'aliexpress', aliexpressProductId, aliexpressSkuId, ebayAccountId: null }) : null);

  if (existing && existing.status !== 'draft') return serialize(existing);

  const sellerEdited = !!existing?.draftCustomized;
  const normalizedAmazonPrice = normalizeAmazonPrice(amazonPrice);
  const update = {
    userId,
    importId: importId || null,
    sourcePlatform: 'aliexpress',
    aliexpressProductId,
    aliexpressSkuId,
    sku: normalizedSku,
    ...(sellerEdited ? {} : {
      title: title || null,
      mainImage: mainImage || null,
      sellPrice: sellPrice ?? null,
      pricingRule: pricingRule && typeof pricingRule === 'object' ? pricingRule : null,
      description: typeof description === 'string' ? description : '',
      bulletPoints: Array.isArray(bulletPoints) ? bulletPoints.map((v) => String(v ?? '').trim()).filter(Boolean) : [],
      specifications: Array.isArray(specifications) ? specifications : [],
      ebayAspects: ebayAspects && typeof ebayAspects === 'object' ? ebayAspects : {},
      markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
      currency: currency || 'USD',
      quantity: quantity ?? 1,
      categoryId: categoryId || null,
      amazonPrice: normalizedAmazonPrice,
      marginAmount: Number.isFinite(Number(marginAmount)) ? Number(marginAmount) : (Number.isFinite(Number(sellPrice)) && normalizedAmazonPrice !== null ? Number((Number(sellPrice) - normalizedAmazonPrice).toFixed(2)) : null),
    }),
    status: 'draft',
  };
  if (sellerEdited && normalizedAmazonPrice !== null) update.amazonPrice = normalizedAmazonPrice;
  if (ebayAccountId !== undefined && !existing?.ebayAccountId) update.ebayAccountId = ebayAccountId || null;
  if (marketplaceId !== undefined && !existing?.marketplaceId) update.marketplaceId = marketplaceId || null;
  if (!existing || !Array.isArray(existing.images) || existing.images.length === 0) {
    update.images = Array.isArray(images) ? images.slice(0, 24) : [];
  }

  const doc = await Listing.findOneAndUpdate(
    existing ? { _id: existing._id } : { userId, sourcePlatform: 'aliexpress', aliexpressProductId, aliexpressSkuId, ebayAccountId: accountKey },
    update,
    { new: true, upsert: true }
  );
  return serialize(doc);
}

/**
 * The Amazon links of a user's drafts (the "Ready to publish" list of the Drafts page: drafts and drafts that failed to publish), oldest
 * first, each link once. A draft with no saved link is left out (no link is ever made up).
 * @returns {Promise<string[]>}
 */
async function listDraftAmazonLinks(userId) {
  const docs = await Listing.find({ userId, status: { $in: ['draft', 'error'] } })
    .select('importId createdAt')
    .populate('importId', 'amazonUrl')
    .sort({ createdAt: 1 })
    .lean();
  const seen = new Set();
  const links = [];
  for (const doc of docs) {
    const url = String((doc.importId && doc.importId.amazonUrl) || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

/** Several of a user's listings in ONE query. Returns a Map: id (string) -> the listing as getListingById gives it. */
async function getListingsByIds(userId, ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
  const out = new Map();
  if (!clean.length) return out;
  const docs = await Listing.find({ _id: { $in: clean }, userId });
  for (const doc of docs) out.set(String(doc._id), serialize(doc));
  return out;
}

/**
 * For a bulk delete: what is needed of each listing to decide how it is removed (its title, and the eBay offer if it has one), read in ONE
 * query as plain objects. An id that is not this user's listing (or not an id at all) is simply not in the answer.
 */
async function getListingsForDelete(userId, ids) {
  const valid = [...new Set((ids || []).map(String))].filter((id) => require('mongoose').isValidObjectId(id));
  if (!valid.length) return [];
  const docs = await Listing.find({ _id: { $in: valid }, userId }).select('title ebayOfferId ebayAccountId').lean();
  return docs.map((d) => ({ id: String(d._id), title: d.title || '', ebay_offer_id: d.ebayOfferId || null, ebay_account_id: d.ebayAccountId ? String(d.ebayAccountId) : null }));
}

/** Removes many of this user's listings with ONE command (scoped to the user). @returns {Promise<number>} how many were removed */
async function deleteListingsMany(userId, ids) {
  const valid = [...new Set((ids || []).map(String))].filter((id) => require('mongoose').isValidObjectId(id));
  if (!valid.length) return 0;
  const res = await Listing.deleteMany({ _id: { $in: valid }, userId });
  return Number((res && res.deletedCount) || 0);
}

async function getListingById(userId, id) {
  const doc = await Listing.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

/**
 * Atomically "claims" a listing for publishing by flipping its status to
 * 'publishing' - but ONLY if it's currently 'draft' or 'error'. Returns the
 * claimed listing on success, or null if it couldn't be claimed (already
 * published, already being published by another in-flight request, etc).
 *
 * This closes a duplicate-publish race condition: without this atomic
 * check-and-set, two near-simultaneous requests (e.g. a fast double-click,
 * or a retried request after a slow response) could both read the listing
 * as "draft", both proceed to call eBay, and create two live listings (and
 * charge two credits) for what the user intended as a single publish.
 * Because the status check and the write happen together in one MongoDB
 * command, only one of the two requests can win the race.
 */
async function claimListingForPublishing(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['draft', 'error'] } },
    { $set: { status: 'publishing', publishStartedAt: new Date(), publishLeaseUntil: null, publishCompletedAt: null, errorMessage: null }, $inc: { publishAttempts: 1 } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** Atomically takes a due scheduled listing for publishing (scheduled -> publishing). Null if it is no longer scheduled. */
async function claimScheduledForPublishing(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'scheduled' },
    { $set: { status: 'publishing', publishStartedAt: new Date(), publishLeaseUntil: null, publishCompletedAt: null, errorMessage: null }, $inc: { publishAttempts: 1 } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function getListingBySku(userId, sku) {
  const doc = await Listing.findOne({ sku, userId });
  return doc ? serialize(doc) : null;
}

/** Every listing of the user for one ASIN (SKU = ASIN), in any store and any state, newest first. */
async function listListingsBySku(userId, sku) {
  const normalized = normalizeAsinSku(sku);
  if (!normalized) return [];
  const docs = await Listing.find({ userId, sku: normalized }).sort({ updatedAt: -1 }).limit(20);
  return docs.map(serialize);
}

/** The listings of the user for several ASINs at once (a light row each): { id, sku, status, ebay_account_id }. */
async function listListingsBySkus(userId, skus) {
  const list = [...new Set((Array.isArray(skus) ? skus : []).map(normalizeAsinSku).filter(Boolean))].slice(0, 200);
  if (!list.length) return [];
  const docs = await Listing.find({ userId, sku: { $in: list } }).select('sku status ebayAccountId').limit(1000).lean();
  return docs.map((d) => ({ id: String(d._id), sku: d.sku, status: d.status, ebay_account_id: d.ebayAccountId ? String(d.ebayAccountId) : null }));
}

/**
 * The listing this ASIN already has in ONE store - the row an import would land on (see upsertDraft: a legacy listing with
 * no store counts for the first store that asks). null when there is none.
 */
async function findListingInStore(userId, sku, ebayAccountId) {
  const normalized = normalizeAsinSku(sku);
  if (!normalized) return null;
  const accountKey = ebayAccountId || null;
  const doc = (await Listing.findOne({ userId, sku: normalized, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sku: normalized, ebayAccountId: null }) : null);
  return doc ? serialize(doc) : null;
}

/**
 * The CJdropshipping equivalent of findListingInStore above: "has this CJ product+variant already been imported into this
 * store". Deliberately its own lookup (by cjProductId/cjVariantId, never by sku or asin) - the spec's "duplicate checks are
 * per source" rule, so a CJ import is never blocked (or wrongly allowed) by an Amazon listing's sku, or the reverse.
 */
async function findCjListingInStore(userId, cjProductId, cjVariantId, ebayAccountId) {
  if (!cjProductId || !cjVariantId) return null;
  const accountKey = ebayAccountId || null;
  const doc = (await Listing.findOne({ userId, sourcePlatform: 'cj', cjProductId, cjVariantId, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sourcePlatform: 'cj', cjProductId, cjVariantId, ebayAccountId: null }) : null);
  return doc ? serialize(doc) : null;
}

/** The AliExpress equivalent of findCjListingInStore above: "has this AliExpress product+sku already been imported into this store". */
async function findAliexpressListingInStore(userId, aliexpressProductId, aliexpressSkuId, ebayAccountId) {
  if (!aliexpressProductId || !aliexpressSkuId) return null;
  const accountKey = ebayAccountId || null;
  const doc = (await Listing.findOne({ userId, sourcePlatform: 'aliexpress', aliexpressProductId, aliexpressSkuId, ebayAccountId: accountKey }))
    || (accountKey ? await Listing.findOne({ userId, sourcePlatform: 'aliexpress', aliexpressProductId, aliexpressSkuId, ebayAccountId: null }) : null);
  return doc ? serialize(doc) : null;
}

// A list of listings (Live listings, Drafts) is read as plain objects, and from each listing's import only what the list uses (the rest of the
// import - A+ content, product information, categories ... - stays in the database; the eBay answer of a publish is not sent either).
const IMPORT_FOR_LIST = 'asin amazonUrl amazonPrice currency product.asin product.price product.brand product.variants product.images product.description product.bulletPoints product.specifications product.ebayAspects';
const LIST_EXCLUDE = '-publishResponse -publishErrorDetails';
const ACCOUNT_FOR_LIST = 'displayName storeName ebayUserId storeNumber';

async function listListingsByStatuses(userId, statuses = [], accountId = null, { since = null } = {}) {
  const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter(Boolean))];
  // since: only what was created or changed after that moment (the Drafts page asks for this every few seconds while a background
  // import runs, so it never reloads the whole queue). It leaves out the two things that are only worth doing for a full list.
  const onlyNew = since instanceof Date && !Number.isNaN(since.getTime());
  if (!onlyNew) await claimUnassignedIfNeeded(userId, accountId);
  const query = cleanStatuses.length ? { userId, status: { $in: cleanStatuses } } : { userId };
  if (accountId) query.ebayAccountId = accountId;
  if (onlyNew) query.$or = [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }];
  const docs = await Listing.find(query)
    .select(LIST_EXCLUDE)
    .populate({ path: 'importId', select: IMPORT_FOR_LIST })
    .populate({ path: 'ebayAccountId', select: ACCOUNT_FOR_LIST })
    .sort({ updatedAt: -1 })
    .lean();
  const soldByListing = onlyNew ? new Map() : await getSoldByListing(userId);
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
    serialized.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
    serialized.asin = doc.importId?.asin || null;
    serialized.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
    serialized.sold_count = soldByListing.get(String(doc._id)) || 0;
    return withImportFallback(serialized, doc);
  });
}

/**
 * The colour / size variants of an imported product, small enough to travel with every listing row: what makes each one
 * different, its own title, one picture and its price (the full picture lists stay on the import).
 */
const { ownVariantOnly } = require('../services/productVariants');
function compactVariants(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => v && v.asin).slice(0, 50).map((v) => ({
    asin: v.asin,
    title: v.title || v.label || null,
    label: v.label || null,
    image: v.image || (Array.isArray(v.images) && v.images[0]) || null,
    price: Number.isFinite(Number(v.price)) && v.price !== null && v.price !== '' ? Number(v.price) : null,
    dimensions: Array.isArray(v.dimensions) ? v.dimensions.filter((d) => d && d.name && d.value).map((d) => ({ name: d.name, value: d.value })) : [],
    isCurrentProduct: v.isCurrentProduct === true,
  }));
}

/** Drafts made before description/bullets/specs were copied onto the listing read them from the linked import. */
function withImportFallback(serialized, doc) {
  const p = doc.importId?.product;
  // Render's disk is ephemeral, so a draft's own re-hosted /uploads/listing-images/... pictures can vanish after a deploy.
  // Drop any that are gone before deciding whether a gallery fallback is needed, so a partially-wiped draft self-heals too.
  if (Array.isArray(serialized.images) && serialized.images.length) {
    serialized.images = serialized.images.filter((u) => !isMissingLocalImage(u));
  }
  if (serialized.main_image && isMissingLocalImage(serialized.main_image)) {
    serialized.main_image = serialized.images[0] || null;
  }
  if (!p) return serialized;
  serialized.variants = compactVariants(ownVariantOnly(p.variants, doc.sku || p.asin)); // only the product itself, also for imports made before
  serialized.variants_count = serialized.variants.length;
  serialized.brand = String(p.brand || '');
  // A draft made by a server-side import had only its main picture saved on it (or lost its own re-hosted copies above);
  // its whole gallery lives on the import too, under the supplier's own stable URLs which our own deploys never touch.
  if (!Array.isArray(serialized.images) || !serialized.images.length) {
    const gallery = (Array.isArray(p.images) ? p.images : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 24);
    if (gallery.length) {
      serialized.images = gallery;
      if (!serialized.main_image) serialized.main_image = gallery[0];
    }
  }
  if (!serialized.description) serialized.description = String(p.description || '');
  if (!Array.isArray(serialized.bullet_points) || !serialized.bullet_points.length) serialized.bullet_points = Array.isArray(p.bulletPoints) ? p.bulletPoints : [];
  if (!Array.isArray(serialized.specifications) || !serialized.specifications.length) serialized.specifications = Array.isArray(p.specifications) ? p.specifications : [];
  if (!serialized.ebay_aspects || !Object.keys(serialized.ebay_aspects).length) serialized.ebay_aspects = p.ebayAspects && typeof p.ebayAspects === 'object' ? p.ebayAspects : {};
  return serialized;
}

function supplierCountryFromUrl(url) {
  const host = String(url || '').toLowerCase();
  if (host.includes('amazon.co.uk')) return 'UK';
  if (host.includes('amazon.com.au')) return 'AU';
  if (host.includes('amazon.ca')) return 'CA';
  if (host.includes('amazon.de')) return 'DE';
  if (host.includes('amazon.fr')) return 'FR';
  if (host.includes('amazon.it')) return 'IT';
  if (host.includes('amazon.es')) return 'ES';
  if (host.includes('amazon.com')) return 'US';
  return null;
}
async function countListingsByStatus(userId, status, accountId = null) {
  const query = { userId, status };
  if (accountId) query.ebayAccountId = accountId;
  return Listing.countDocuments(query);
}

// Every status a Listing can be in (models/schemas/Listing.js) - kept here (not re-derived from the schema) so the admin
// lookup below always shows every status, including one that currently has zero listings.
const LISTING_STATUSES = ['draft', 'publishing', 'scheduled', 'published', 'paused', 'error', 'ended', 'sold'];

/** How many of one user's listings are in each status, in one aggregate - for the Admin Panel's User Lookup page. */
async function listingStatusBreakdown(userId) {
  const rows = await Listing.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(String(userId)) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const by = new Map(rows.map((r) => [r._id, r.count]));
  const counts = {};
  LISTING_STATUSES.forEach((s) => { counts[s] = by.get(s) || 0; });
  return counts;
}

/**
 * Listings saved before drafts were tied to an eBay account have no account.
 * When one store is being viewed, give those listings a home once: the store
 * whose marketplace matches the listing (or the Amazon supplier country), and
 * otherwise the user's oldest connected store. After that every store only ever
 * sees its own listings.
 */
async function claimUnassignedListings(userId, accountId) {
  if (!accountId) return 0;
  try {
    const orphans = await Listing.find({ userId, ebayAccountId: null }).populate({ path: 'importId', select: 'amazonUrl' }).lean();
    if (!orphans.length) return 0;
    const accounts = await EbayAccount.find({ userId, disconnectedAt: null }).sort({ createdAt: 1 }).lean();
    if (!accounts.length) return 0;
    const byMarket = new Map();
    for (const a of accounts) if (!byMarket.has(a.marketplaceId || 'EBAY_US')) byMarket.set(a.marketplaceId || 'EBAY_US', a);
    const SUPPLIER_MARKET = { UK: 'EBAY_GB', US: 'EBAY_US', AU: 'EBAY_AU', CA: 'EBAY_CA', DE: 'EBAY_DE', FR: 'EBAY_FR', IT: 'EBAY_IT', ES: 'EBAY_ES' };
    let moved = 0;
    for (const l of orphans) {
      const market = l.marketplaceId || SUPPLIER_MARKET[supplierCountryFromUrl(l.importId?.amazonUrl)] || null;
      const target = (market && byMarket.get(market)) || accounts[0];
      await Listing.updateOne({ _id: l._id, ebayAccountId: null }, { $set: { ebayAccountId: target._id, marketplaceId: l.marketplaceId || target.marketplaceId || null } });
      moved += 1;
    }
    return moved;
  } catch (err) {
    console.warn('claimUnassignedListings failed:', err.message);
    return 0;
  }
}

/**
 * Listings saved before drafts were tied to a store are given one (claimUnassignedListings) - but only when there is something to give: one cheap
 * "is there a listing with no store?" check, and a user with none is not asked again for ten minutes. (It used to read every store-less listing with
 * its import on EVERY list request.) It is also run when an eBay store is connected (see models/ebayAccountsModel.js).
 */
const claimClean = new Map(); // userId -> when they were last found to have no listing without a store
const CLAIM_CLEAN_MS = 10 * 60 * 1000;
async function claimUnassignedIfNeeded(userId, accountId) {
  if (!accountId) return 0;
  const key = String(userId);
  const seen = claimClean.get(key);
  if (seen && Date.now() - seen < CLAIM_CLEAN_MS) return 0;
  try {
    const orphan = await Listing.exists({ userId, ebayAccountId: null });
    if (!orphan) { claimClean.set(key, Date.now()); if (claimClean.size > 5000) claimClean.delete(claimClean.keys().next().value); return 0; }
  } catch (_) { return 0; }
  const moved = await claimUnassignedListings(userId, accountId);
  claimClean.delete(key);
  return moved;
}
/** A new store was connected: the listings without one may now be given a home; the "nothing to claim" memory is forgotten. */
async function claimAfterStoreConnected(userId, accountId) {
  claimClean.delete(String(userId));
  return claimUnassignedListings(userId, accountId);
}

/** Units sold per listing, from the synced eBay orders. `listingIds` (the rows of one page) limits it to those listings; without it every listing of the user is counted. */
async function getSoldByListing(userId, listingIds = null) {
  try {
    const Order = require('./schemas/Order');
    const mongoose = require('mongoose');
    const match = { userId: new mongoose.Types.ObjectId(String(userId)), listingId: { $ne: null } };
    if (Array.isArray(listingIds)) {
      if (!listingIds.length) return new Map();
      match.listingId = { $in: listingIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(String(id))) };
    }
    const rows = await Order.aggregate([
      { $match: match },
      { $group: { _id: '$listingId', sold: { $sum: { $ifNull: ['$quantity', 1] } } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.sold]));
  } catch (_) {
    return new Map();
  }
}

async function listListings(userId, status, accountId = null) {
  await claimUnassignedIfNeeded(userId, accountId);
  const query = status ? { userId, status } : { userId };
  if (accountId) query.ebayAccountId = accountId;
  await excludeDisconnectedAccounts(query, userId);
  const docs = await Listing.find(query).select(LIST_EXCLUDE).populate({ path: 'importId', select: IMPORT_FOR_LIST }).populate({ path: 'ebayAccountId', select: ACCOUNT_FOR_LIST }).sort({ updatedAt: -1 }).lean();
  const soldByListing = await getSoldByListing(userId);
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
    serialized.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
    serialized.asin = doc.importId?.asin || null;
    serialized.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
    serialized.sold_count = soldByListing.get(String(doc._id)) || 0;
    return withImportFallback(serialized, doc);
  });
}

// ---------------------------------------------------------------- Live listings: one page at a time
// The Live listings page used to load EVERY listing with its import (description, bullets, specifications ...) and sort / filter / count them in the
// browser, which took minutes for a big store. Now the server does the searching, filtering, sorting and paging, and a row carries only what the list shows;
// what the editor needs (description, pictures, item specifics ...) is read for the ONE listing that is opened (getListingFull).
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const PAGE_SELECT = 'sku title mainImage sellPrice amazonPrice status ebayAccountId marketplaceId currency quantity soldQuantity ebayListingId ebayOfferId categoryId errorMessage note markupPercent pricingRule views watchers statsSyncedAt createdAt updatedAt importId amazonInStock stockMonitoring priceMonitoring sourcePlatform cjProductId cjVariantId cjShippingCost';
const VERO_TEXT_FIELDS = 'description bulletPoints specifications ebayAspects'; // read for the rows of one page only, to flag VeRO words; never sent
const IMPORT_FOR_PAGE = 'asin amazonUrl amazonPrice product.price';
const KEYS_NOT_IN_A_ROW = ['description', 'bullet_points', 'specifications', 'ebay_aspects', 'images', 'images_customized', 'ebay_image_urls', 'publish_response', 'publish_error_details', 'tags', 'draft_customized'];
const SIMPLE_SORTS = {
  newest: { createdAt: -1, _id: -1 },
  price: { sellPrice: -1, _id: -1 },
  priceLow: { sellPrice: 1, _id: 1 },
  views: { views: -1, _id: -1 },
  watchers: { watchers: -1, _id: -1 },
};
const COMPUTED_SORTS = new Set(['profit', 'profitLow', 'sold']); // these need the Amazon price / the orders: worked out from a light read of every matching listing
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The page and limit of a request, made safe: page 1.., limit 1..200 (default 50). */
function pageOptions({ page, limit } = {}) {
  const p = Math.max(1, Math.trunc(Number(page)) || 1);
  const l = Math.min(PAGE_MAX, Math.max(1, Math.trunc(Number(limit)) || PAGE_DEFAULT));
  return { page: p, limit: l };
}

/** The database filter of the list: the seller's listings, in these statuses, of this store and source (Amazon/CJ), whose title / SKU / eBay item number / note holds the search text. */
function pageQuery(userId, { statuses = [], accountId = null, q = '', source = null } = {}) {
  const query = { userId };
  const list = [...new Set((Array.isArray(statuses) ? statuses : []).filter(Boolean))];
  if (list.length) query.status = { $in: list };
  if (accountId) query.ebayAccountId = accountId;
  if (source === 'amazon' || source === 'cj') query.sourcePlatform = source;
  const text = String(q || '').trim().slice(0, 100);
  if (text) {
    const re = new RegExp(escapeRegExp(text), 'i');
    query.$or = [{ title: re }, { sku: re }, { ebayListingId: re }, { note: re }];
  }
  return query;
}

/**
 * A "combined, every store" query (no accountId picked) never shows a disconnected store's listings - they are hidden,
 * not deleted (models/ebayAccountsModel.js removeEbayAccount), and reappear once the seller reconnects that store. A
 * query already scoped to one accountId is untouched, whether that store happens to be connected or not.
 */
async function excludeDisconnectedAccounts(query, userId) {
  if (query.ebayAccountId) return query;
  const disconnected = await EbayAccount.find({ userId, disconnectedAt: { $ne: null } }).select('_id').lean();
  if (disconnected.length) query.ebayAccountId = { $nin: disconnected.map((d) => d._id) };
  return query;
}

/**
 * The profit the card shows (after eBay's fees when the listing was priced by the Margin rule): the same rule as the page's
 * listingProfit. null when there is no price or cost. `extraCost` is CJ's own shipping cost (Listing.cjShippingCost) added to
 * the source cost for a CJ listing; it is always 0 for an Amazon listing, so Amazon profit is worked out exactly as before.
 */
function listingProfitAmount(sellPrice, amazon, rule, extraCost = 0) {
  const sell = numOrNull(sellPrice);
  const cost = numOrNull(amazon);
  if (sell === null || cost === null) return null;
  const extra = numOrNull(extraCost) || 0;
  if (rule && typeof rule === 'object' && numOrNull(rule.feePercent) !== null) {
    const costTotal = cost + extra + (numOrNull(rule.shipping) || 0);
    return sell - costTotal - (sell * numOrNull(rule.feePercent) / 100 + (numOrNull(rule.feeFixed) || 0));
  }
  return sell - cost - extra;
}

/** A light read of every listing of a filter: only what sorting, the summary and the "select all" need, with the Amazon price the list shows (the import's when the listing has none). */
async function lightRows(query, extraSelect = '') {
  const docs = await Listing.find(query).select('sellPrice amazonPrice cjShippingCost pricingRule importId status views watchers statsSyncedAt createdAt ' + extraSelect).lean();
  const needImport = docs.filter((d) => normalizeAmazonPrice(d.amazonPrice) === null && d.importId).map((d) => d.importId);
  const imports = new Map();
  if (needImport.length) {
    const Import = require('./schemas/Import');
    const rows = await Import.find({ _id: { $in: needImport } }).select('amazonPrice product.price').lean();
    rows.forEach((r) => imports.set(String(r._id), r));
  }
  return docs.map((d) => {
    const imp = d.importId ? imports.get(String(d.importId)) : null;
    const amazon = normalizeAmazonPrice(d.amazonPrice) ?? normalizeAmazonPrice(imp && imp.amazonPrice) ?? normalizeAmazonPrice(imp && imp.product && imp.product.price);
    return { doc: d, id: String(d._id), amazon };
  });
}

// ----- VeRO words: which listings hold one (worked out on the server, kept for two minutes per store view) -----
const veroCache = new Map(); // key -> { at, terms: Map(id -> terms[]) }
const VERO_CACHE_MS = 2 * 60 * 1000;
async function veroMatcherOf(userId) {
  const { getVeroWordsOf } = require('../services/veroSettingsService');
  const { createMatcher } = require('../services/veroService');
  const matcher = createMatcher(await getVeroWordsOf(userId));
  return matcher.hasWords ? matcher : null;
}
/** Every listing of this filter that holds a VeRO word: Map(id -> terms). Empty when the seller has no VeRO words. */
async function scanVero(userId, query) {
  const matcher = await veroMatcherOf(userId);
  if (!matcher) return new Map();
  const key = String(userId) + '|' + JSON.stringify({ ...query, $or: undefined });
  const hit = veroCache.get(key);
  if (hit && Date.now() - hit.at < VERO_CACHE_MS) return hit.terms;
  const terms = new Map();
  const base = { ...query };
  delete base.$or; // a search does not change which listings hold a VeRO word
  const cursor = Listing.find(base).select('title ' + VERO_TEXT_FIELDS).lean().cursor();
  for await (const d of cursor) {
    const found = matcher.scanListing({ title: d.title, description: d.description, bulletPoints: d.bulletPoints, specifications: d.specifications, aspects: d.ebayAspects });
    if (found.terms.length) terms.set(String(d._id), found.terms);
  }
  veroCache.set(key, { at: Date.now(), terms });
  if (veroCache.size > 200) veroCache.delete(veroCache.keys().next().value);
  return terms;
}
function clearVeroCache(userId) {
  const prefix = String(userId) + '|';
  for (const k of [...veroCache.keys()]) if (k.startsWith(prefix)) veroCache.delete(k);
}

/** One row of the list: the same names the page already uses, without the heavy fields (description, bullets, specifications, item specifics, all pictures ...). */
function pageRow(doc, { soldByListing, veroTerms }) {
  const row = serialize(doc);
  for (const k of KEYS_NOT_IN_A_ROW) delete row[k];
  row.amazon_url = doc.importId?.amazonUrl || null;
  row.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
  row.asin = doc.importId?.asin || null;
  row.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
  row.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
  row.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
  row.sold_count = soldByListing.get(String(doc._id)) || 0;
  row.vero_terms = veroTerms;
  return row;
}

/** The rows of these listing ids, in this order (one query, populated with the little the list needs). */
async function readPageRows(userId, ids, { withVero = false } = {}) {
  if (!ids.length) return [];
  const matcher = withVero ? await veroMatcherOf(userId) : null; // a seller with no VeRO words: the text of the listings is never even read
  const select = PAGE_SELECT + (matcher ? ' ' + VERO_TEXT_FIELDS : '');
  const docs = await Listing.find({ _id: { $in: ids }, userId })
    .select(select)
    .populate({ path: 'importId', select: IMPORT_FOR_PAGE })
    .populate({ path: 'ebayAccountId', select: ACCOUNT_FOR_LIST })
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const soldByListing = await getSoldByListing(userId, ids.map(String)); // only the listings of this page are counted
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map((doc) => {
    const veroTerms = matcher ? matcher.scanListing({ title: doc.title, description: doc.description, bulletPoints: doc.bulletPoints, specifications: doc.specifications, aspects: doc.ebayAspects }).terms : [];
    return pageRow(doc, { soldByListing, veroTerms });
  });
}

/**
 * One page of listings, searched / filtered / sorted by the database.
 * @param {object} opts { statuses, accountId, q (search text), sort (newest|price|priceLow|profit|profitLow|views|watchers|sold), vero (only listings with a VeRO word), page, limit }
 * @returns {Promise<{ listings: object[], total: number, page: number, limit: number, pages: number }>}
 */
async function listListingsPage(userId, { statuses = [], accountId = null, q = '', sort = 'newest', vero = false, source = null, page, limit } = {}) {
  const { page: p, limit: l } = pageOptions({ page, limit });
  await claimUnassignedIfNeeded(userId, accountId);
  const query = await excludeDisconnectedAccounts(pageQuery(userId, { statuses, accountId, q, source }), userId);
  let veroTerms = null;
  if (vero) {
    veroTerms = await scanVero(userId, query);
    query._id = { $in: [...veroTerms.keys()] };
  }
  const total = await Listing.countDocuments(query);
  const pages = Math.max(1, Math.ceil(total / l));
  const empty = { listings: [], total, page: p, limit: l, pages };
  if (!total || p > pages) return empty;

  let ids;
  if (COMPUTED_SORTS.has(sort)) {
    // profit and units sold are not fields of a listing: they are worked out from a light read of every matching listing, then the page is cut out of the sorted ids
    const rows = await lightRows(query);
    let key;
    if (sort === 'sold') {
      const sold = await getSoldByListing(userId);
      key = (r) => sold.get(r.id) || 0;
    } else {
      key = (r) => listingProfitAmount(r.doc.sellPrice, r.amazon, r.doc.pricingRule, r.doc.cjShippingCost);
    }
    const up = sort === 'profitLow';
    const scored = rows.map((r) => ({ id: r.id, score: key(r), created: r.doc.createdAt ? new Date(r.doc.createdAt).getTime() : 0 }));
    scored.sort((a, b) => {
      if (a.score === null && b.score === null) return b.created - a.created;
      if (a.score === null) return 1; // no price or cost: last, either way
      if (b.score === null) return -1;
      return (up ? a.score - b.score : b.score - a.score) || b.created - a.created;
    });
    ids = scored.slice((p - 1) * l, p * l).map((r) => r.id);
  } else {
    const docs = await Listing.find(query).select('_id').sort(SIMPLE_SORTS[sort] || SIMPLE_SORTS.newest).skip((p - 1) * l).limit(l).lean();
    ids = docs.map((d) => String(d._id));
  }
  let listings = await readPageRows(userId, ids, { withVero: !veroTerms });
  if (veroTerms) listings = listings.map((row) => ({ ...row, vero_terms: veroTerms.get(row.id) || [] }));
  return { listings, total, page: p, limit: l, pages };
}

/** Every listing id of a filter (for "Select all N"), at most 20,000. */
async function listListingIds(userId, { statuses = [], accountId = null, q = '', vero = false, source = null } = {}) {
  const query = await excludeDisconnectedAccounts(pageQuery(userId, { statuses, accountId, q, source }), userId);
  if (vero) query._id = { $in: [...(await scanVero(userId, query)).keys()] };
  const docs = await Listing.find(query).select('_id').sort({ createdAt: -1, _id: -1 }).limit(20000).lean();
  return docs.map((d) => String(d._id));
}

/** The rows of these ids (the Change price window needs the selected listings, wherever they were on the list). At most 5000. */
async function listRowsByIds(userId, ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => require('mongoose').isValidObjectId(id)).slice(0, 5000);
  return readPageRows(userId, clean);
}

/**
 * What the Live listings page shows above the list, in one answer: how many listings each tab has, and the totals (units sold, views, watchers,
 * average margin, when views were last synced). Worked out from a light read, not from full listings. `vero` is only worked out when the seller has VeRO words.
 */
async function summarizeLiveListings(userId, { accountId = null } = {}) {
  // 'sold' (out of stock, see models/ordersModel.js markSoldIfOut) is still a live listing for every purpose here
  // (units sold, views, watchers, margin, VeRO) except the "Active" count, which is 'published' only.
  const live = { userId, status: { $in: ['published', 'sold'] } };
  if (accountId) live.ebayAccountId = accountId;
  const ended = { userId, status: 'ended' };
  if (accountId) ended.ebayAccountId = accountId;
  const issues = { userId, status: 'error' };
  if (accountId) issues.ebayAccountId = accountId;
  const [rows, endedCount, issuesCount, sold, veroTerms] = await Promise.all([lightRows(live), Listing.countDocuments(ended), Listing.countDocuments(issues), getSoldByListing(userId), scanVero(userId, live)]);
  let views = 0; let watchers = 0; let units = 0; let last = 0; let activeCount = 0; let soldCount = 0;
  const margins = [];
  for (const r of rows) {
    views += numOrNull(r.doc.views) || 0;
    watchers += numOrNull(r.doc.watchers) || 0;
    units += sold.get(r.id) || 0;
    if (r.doc.status === 'sold') soldCount += 1; else activeCount += 1;
    const t = r.doc.statsSyncedAt ? new Date(r.doc.statsSyncedAt).getTime() : 0;
    if (t > last) last = t;
    const sell = numOrNull(r.doc.sellPrice);
    if (r.amazon > 0 && sell > 0) margins.push((sell - r.amazon) / sell);
  }
  return {
    counts: { all: rows.length, active: activeCount, sold: soldCount, ended: endedCount, issues: issuesCount, vero: veroTerms.size },
    totals: {
      units_sold: units, views, watchers,
      average_margin_percent: margins.length ? Math.round((margins.reduce((a, b) => a + b, 0) / margins.length) * 100) : null,
      last_synced_at: last ? new Date(last).toISOString() : null,
    },
  };
}

/** One listing with everything the editor needs (description, pictures, item specifics, variants ...): what the list used to carry for every row. */
async function getListingFull(userId, id) {
  if (!require('mongoose').isValidObjectId(id)) return null;
  const doc = await Listing.findOne({ _id: id, userId }).select(LIST_EXCLUDE).populate({ path: 'importId', select: IMPORT_FOR_LIST }).populate({ path: 'ebayAccountId', select: ACCOUNT_FOR_LIST }).lean();
  if (!doc) return null;
  const sold = await getSoldByListing(userId, [String(doc._id)]);
  const row = serialize(doc);
  row.amazon_url = doc.importId?.amazonUrl || null;
  row.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
  row.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
  row.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
  row.asin = doc.importId?.asin || null;
  row.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
  row.sold_count = sold.get(String(doc._id)) || 0;
  return withImportFallback(row, doc);
}

/** Calls `fn(rows)` with the listings of a filter, a thousand at a time (for the CSV file), newest first: never all of them in memory at once. */
async function eachListingChunk(userId, { statuses = [], accountId = null, q = '', vero = false, source = null } = {}, fn) {
  const query = await excludeDisconnectedAccounts(pageQuery(userId, { statuses, accountId, q, source }), userId);
  if (vero) query._id = { $in: [...(await scanVero(userId, query)).keys()] };
  let before = null;
  for (;;) {
    const find = before ? { ...query, $and: [{ _id: { $lt: before } }] } : query;
    const docs = await Listing.find(find).select('title sku sellPrice quantity categoryId status').sort({ _id: -1 }).limit(1000).lean();
    if (!docs.length) break;
    await fn(docs.map((d) => ({ title: d.title, sku: d.sku, sell_price: d.sellPrice, quantity: d.quantity, category_id: d.categoryId, status: d.status })));
    before = docs[docs.length - 1]._id;
    if (docs.length < 1000) break;
  }
}

/**
 * Updates any editable fields on a draft listing before it's published.
 * Only fields that are provided (not undefined) are updated. Scoped to the
 * given user so one user can never edit another's listing.
 */
async function updateListing(userId, id, fields) {
  clearVeroCache(userId); // the words of this listing may have changed: the next VeRO check reads them again
  // If the price changed but no explicit markup came with it (e.g. the quick inline-card
  // save, which only ever sends sellPrice), keep the stored markup% honest by deriving it
  // from the new price against the listing's Amazon cost - otherwise it silently goes stale
  // and later shows a markup the seller never actually set (see draftRowHtml's note on why
  // the shown "%" is the stored markup, not one recomputed from profit/sellPrice).
  if (fields.sellPrice !== undefined && fields.markupPercent === undefined) {
    const existing = await Listing.findOne({ _id: id, userId }).select('amazonPrice').lean();
    const amazonPrice = normalizeAmazonPrice(existing?.amazonPrice);
    const sell = Number(fields.sellPrice);
    if (amazonPrice && amazonPrice > 0 && Number.isFinite(sell)) {
      fields = { ...fields, markupPercent: Number((((sell / amazonPrice) - 1) * 100).toFixed(2)) };
    }
  }

  // A price typed by hand ends the pricing rule for this listing: from then on a re-pricing keeps the seller's own cash margin, as it
  // always did. Saving the same price again (an editor save that only changed the title) keeps the rule.
  let pricingRuleUpdate;
  if (fields.pricingRule !== undefined) {
    pricingRuleUpdate = fields.pricingRule && typeof fields.pricingRule === 'object' ? fields.pricingRule : null;
  } else if (fields.sellPrice !== undefined) {
    const before = await Listing.findOne({ _id: id, userId }).select('sellPrice pricingRule').lean();
    if (before && before.pricingRule && Math.round(Number(before.sellPrice) * 100) !== Math.round(Number(fields.sellPrice) * 100)) pricingRuleUpdate = null;
  }

  const update = {};
  if (fields.title !== undefined) update.title = fields.title;
  if (fields.images !== undefined) {
    update.imagesCustomized = true;
    update.images = Array.from(new Set((Array.isArray(fields.images) ? fields.images : [])
      .map((url) => String(url || '').trim())
      .filter((url) => /^https?:\/\//i.test(url)))).slice(0, 24);
    update.mainImage = update.images[0] || null;
  } else if (fields.mainImage !== undefined) {
    update.mainImage = fields.mainImage || null;
  }
  if (fields.sellPrice !== undefined) update.sellPrice = fields.sellPrice;
  if (pricingRuleUpdate !== undefined) update.pricingRule = pricingRuleUpdate;
  if (fields.amazonPrice !== undefined) {
    const sourcePrice = normalizeAmazonPrice(fields.amazonPrice);
    if (sourcePrice !== null) update.amazonPrice = sourcePrice;
  }
  if (fields.marginAmount !== undefined) {
    const margin = Number(fields.marginAmount);
    if (Number.isFinite(margin)) update.marginAmount = Number(margin.toFixed(2));
  }
  if (fields.cjShippingCost !== undefined) {
    const shipping = Number(fields.cjShippingCost);
    update.cjShippingCost = Number.isFinite(shipping) ? Number(shipping.toFixed(2)) : null;
  }
  if (fields.repricingEnabled !== undefined) update.repricingEnabled = fields.repricingEnabled !== false;
  if (fields.lastRepricedAt !== undefined) update.lastRepricedAt = fields.lastRepricedAt || null;
  if (fields.lastStockCheckedAt !== undefined) update.lastStockCheckedAt = fields.lastStockCheckedAt || null;
  if (fields.amazonInStock !== undefined) {
    update.amazonInStock = fields.amazonInStock === null ? null : fields.amazonInStock === true;
  }
  if (fields.lastStockSyncedAt !== undefined) update.lastStockSyncedAt = fields.lastStockSyncedAt || null;
  if (fields.description !== undefined) update.description = typeof fields.description === 'string' ? fields.description : '';
  if (fields.bulletPoints !== undefined) update.bulletPoints = Array.isArray(fields.bulletPoints) ? fields.bulletPoints.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  if (fields.specifications !== undefined) update.specifications = Array.isArray(fields.specifications) ? fields.specifications : [];
  if (fields.ebayAspects !== undefined) update.ebayAspects = fields.ebayAspects && typeof fields.ebayAspects === 'object' ? fields.ebayAspects : {};
  if (fields.markupPercent !== undefined) {
    const markup = Number(fields.markupPercent);
    if (Number.isFinite(markup) && markup >= -99 && markup <= 1000) update.markupPercent = markup;
  }
  if (fields.currency !== undefined) update.currency = fields.currency;
  if (fields.quantity !== undefined) update.quantity = fields.quantity;
  if (fields.categoryId !== undefined) update.categoryId = fields.categoryId;
  if (fields.ebayAccountId !== undefined) update.ebayAccountId = fields.ebayAccountId || null;
  if (fields.marketplaceId !== undefined) update.marketplaceId = fields.marketplaceId || null;
  Object.assign(update, buildSettingsUpdate(fields));
  if (fields.markDraftCustomized !== false) update.draftCustomized = true;

  const doc = await Listing.findOneAndUpdate({ _id: id, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const POSTAL_CODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;
const POLICY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates and converts the per-product settings (tags, policies, location,
 * monitoring) from the request body into a Mongoose update object. Unknown or
 * invalid values are ignored rather than stored.
 */
function buildSettingsUpdate(fields = {}) {
  const update = {};
  const text = (v, max) => (v === null || v === '' ? null : String(v).trim().slice(0, max));
  if (fields.tags !== undefined) {
    const list = Array.isArray(fields.tags) ? fields.tags : String(fields.tags || '').split(',');
    update.tags = Array.from(new Set(list.map((t) => String(t || '').trim().slice(0, 40)).filter(Boolean))).slice(0, 30);
  }
  if (fields.shippingMethod !== undefined) update.shippingMethod = text(fields.shippingMethod, 60);
  // The private note: kept as typed (line breaks stay), trimmed and cut at 2000 characters; empty clears it.
  if (fields.note !== undefined) update.note = fields.note === null ? '' : String(fields.note).replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (fields.useDynamicPolicies !== undefined) update.useDynamicPolicies = fields.useDynamicPolicies === true;
  for (const [key, column] of [['paymentPolicyId', 'paymentPolicyId'], ['fulfillmentPolicyId', 'fulfillmentPolicyId'], ['returnPolicyId', 'returnPolicyId']]) {
    if (fields[key] === undefined) continue;
    const v = text(fields[key], 64);
    if (v === null || POLICY_ID.test(v)) update[column] = v;
  }
  if (fields.countryLocation !== undefined) {
    const v = text(fields.countryLocation, 2);
    if (v === null) update.countryLocation = null;
    else if (COUNTRY_CODE.test(v)) update.countryLocation = (v.toUpperCase() === 'UK' ? 'GB' : v.toUpperCase());
  }
  if (fields.locationCity !== undefined) update.locationCity = text(fields.locationCity, 80);
  if (fields.postalCode !== undefined) {
    const v = text(fields.postalCode, 12);
    if (v === null) update.postalCode = null;
    else if (POSTAL_CODE.test(v)) update.postalCode = v.toUpperCase();
  }
  if (fields.stockMonitoring !== undefined) update.stockMonitoring = fields.stockMonitoring !== false;
  if (fields.priceMonitoring !== undefined) update.priceMonitoring = fields.priceMonitoring !== false;
  return update;
}

/**
 * Saves ONLY the per-product settings (no title/price/images). Safe to call on
 * listings in any status, including published ones.
 */
async function updateListingSettings(userId, id, fields) {
  const update = buildSettingsUpdate(fields);
  if (!Object.keys(update).length) return getListingById(userId, id);
  const doc = await Listing.findOneAndUpdate({ _id: id, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

/**
 * Stores eBay traffic numbers (views / watchers) for one listing.
 */
async function updateListingStats(userId, id, { views, watchers }) {
  const update = { statsSyncedAt: new Date() };
  // null means "eBay did not say": Number(null) is 0, which would wipe a real count.
  if (views != null && Number.isFinite(Number(views))) { update.views = Math.max(0, Math.trunc(Number(views))); update.viewsSyncedAt = update.statsSyncedAt; }
  if (watchers != null && Number.isFinite(Number(watchers))) update.watchers = Math.max(0, Math.trunc(Number(watchers)));
  const doc = await Listing.findOneAndUpdate({ _id: id, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

/**
 * Marks a listing as successfully published, storing eBay's returned IDs.
 */
async function markPublished(userId, id, { offerId, listingId, ebayAccountId, publishResponse = null, ebayImageUrls = [] }) {
  const update = {
    status: 'published',
    ebayOfferId: offerId || null,
    ebayListingId: listingId || null,
    errorMessage: null,
    publishCompletedAt: new Date(),
    publishErrorDetails: null,
    publishResponse: publishResponse || null,
    ebayImageUrls: Array.isArray(ebayImageUrls) ? ebayImageUrls : [],
    publishCreditCharged: false,
    publishLeaseUntil: null,
  };
  if (ebayAccountId !== undefined) update.ebayAccountId = ebayAccountId;

  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    update,
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Marks a listing as failed to publish, storing the error for display.
 */
async function resetErrorToDraft(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'error' },
    { status: 'draft', errorMessage: null, publishErrorDetails: null, publishResponse: null, publishCreditCharged: false },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function markError(userId, id, errorMessage, errorDetails = null) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    {
      status: 'error',
      errorMessage: errorMessage || 'Unknown error',
      publishCompletedAt: new Date(),
      publishErrorDetails: errorDetails || null,
      publishLeaseUntil: null,
    },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Marks a listing as ended (withdrawn from eBay), e.g. because the source
 * Amazon product went out of stock. Not scoped to a single user since this
 * is called by the background stock monitor across all users.
 */
async function markPaused(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'paused', errorMessage: null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function markEnded(userId, id, reason) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'ended', errorMessage: reason || 'Ended: out of stock on Amazon' },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** Restocking a sold-out listing (services/liveBulkRestockService.js, after eBay has already taken the new quantity):
 * back to 'published' with a fresh quantity and a soldQuantity of 0, so the next sale is counted fresh against it. Only
 * ever moves a listing OUT of 'sold' - never touches one of any other status. */
async function restockListing(userId, id, quantity) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'sold' },
    { status: 'published', quantity, soldQuantity: 0, lastStockSyncedAt: new Date() },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Returns every listing (across all users) currently marked as published,
 * with its source import's ASIN and its owning user's ID attached.
 * Used by the stock monitor, which runs for everyone, not one user at a time.
 */
/**
 * Returns every listing currently marked as published (or sold-out but still live on eBay - see the 'sold' status
 * comment above), with its source import's ASIN attached - used by the stock monitor. If userId is given, only that
 * user's published listings are returned (used by the per-user scheduled stock check).
 *
 * 'sold' is included for the same reason summarizeLiveListings already treats it as still-live: without it, a
 * listing that sold out keeps its pre-sellout Amazon price baseline frozen until it happens to be restocked and
 * picked up on a LATER run - up to a full stockCheckIntervalDays - so it can go back live at a stale price.
 */
async function listPublishedListings(userId) {
  const query = { status: { $in: ['published', 'sold'] } };
  if (userId) query.userId = userId;

  const docs = await Listing.find(query).populate('importId');
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.asin = doc.importId?.asin || null;
    // Which Amazon site the product came from: the stock and price checks must ask THAT site.
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    // The last Amazon price we saw for this product (used by the price
    // monitor as the baseline to detect a change against).
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    return serialized;
  });
}

/**
 * String id of a reference field. After .populate() the field holds the whole populated document,
 * and toString() on that gives "[object Object]" - which the UI then sent back as an account id.
 */
function idString(ref) {
  if (!ref) return null;
  return String(ref._id || ref);
}

/**
 * Converts a Mongoose document into the plain shape the rest of the app expects.
 */
function serialize(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc; // a plain object (a lean read) or a document
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    import_id: idString(obj.importId),
    ebay_account_id: idString(obj.ebayAccountId),
  marketplace_id: obj.marketplaceId || null,
    sku: obj.sku,
    source_platform: obj.sourcePlatform || 'amazon',
    cj_product_id: obj.cjProductId || null,
    cj_variant_id: obj.cjVariantId || null,
    cj_shipping_cost: Number.isFinite(Number(obj.cjShippingCost)) ? Number(obj.cjShippingCost) : null,
    aliexpress_product_id: obj.aliexpressProductId || null,
    aliexpress_sku_id: obj.aliexpressSkuId || null,
    title: obj.title,
    main_image: obj.mainImage,
    images: Array.isArray(obj.images) ? obj.images : [],
    images_customized: !!obj.imagesCustomized,
    sell_price: obj.sellPrice,
    amazon_price: normalizeAmazonPrice(obj.amazonPrice),
    margin_amount: Number.isFinite(Number(obj.marginAmount)) ? Number(obj.marginAmount) : null,
    repricing_enabled: obj.repricingEnabled !== false,
    last_repriced_at: obj.lastRepricedAt || null,
    last_stock_checked_at: obj.lastStockCheckedAt || null,
    amazon_in_stock: obj.amazonInStock === null || obj.amazonInStock === undefined ? null : !!obj.amazonInStock,
    last_stock_synced_at: obj.lastStockSyncedAt || null,
    draft_customized: !!obj.draftCustomized,
    description: obj.description || '',
    bullet_points: Array.isArray(obj.bulletPoints) ? obj.bulletPoints : [],
    specifications: Array.isArray(obj.specifications) ? obj.specifications : [],
    ebay_aspects: obj.ebayAspects && typeof obj.ebayAspects === 'object' ? obj.ebayAspects : {},
    markup_percent: Number.isFinite(Number(obj.markupPercent)) ? Number(obj.markupPercent) : 0,
    currency: obj.currency || 'USD',
    quantity: obj.quantity,
    sold_quantity: obj.soldQuantity || 0,
    category_id: obj.categoryId,
    ebay_offer_id: obj.ebayOfferId,
    ebay_listing_id: obj.ebayListingId,
    status: obj.status,
    scheduled_at: obj.scheduledAt,
    error_message: obj.errorMessage,
    publish_started_at: obj.publishStartedAt,
    publish_completed_at: obj.publishCompletedAt,
    publish_attempts: obj.publishAttempts || 0,
    publish_credit_charged: !!obj.publishCreditCharged,
    publish_response: obj.publishResponse || null,
    ebay_image_urls: Array.isArray(obj.ebayImageUrls) ? obj.ebayImageUrls : [],
    publish_error_details: obj.publishErrorDetails || null,
    tags: Array.isArray(obj.tags) ? obj.tags : [],
    note: obj.note || '',
    shipping_method: obj.shippingMethod || null,
    use_dynamic_policies: !!obj.useDynamicPolicies,
    payment_policy_id: obj.paymentPolicyId || null,
    shipping_policy_id: obj.fulfillmentPolicyId || null,
    return_policy_id: obj.returnPolicyId || null,
    country_location: obj.countryLocation || null,
    location_city: obj.locationCity || null,
    postal_code: obj.postalCode || null,
    stock_monitoring: obj.stockMonitoring !== false,
    price_monitoring: obj.priceMonitoring !== false,
    pricing_rule: obj.pricingRule && typeof obj.pricingRule === 'object' ? obj.pricingRule : null,
    views: Number.isFinite(Number(obj.views)) && obj.views !== null ? Number(obj.views) : null,
    watchers: Number.isFinite(Number(obj.watchers)) && obj.watchers !== null ? Number(obj.watchers) : null,
    stats_synced_at: obj.statsSyncedAt || null,
    is_error: obj.status === 'error',
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

/**
 * Marks a draft (or previously errored) listing as scheduled to publish
 * automatically at the given time. Scoped to the given user.
 */
async function scheduleListing(userId, id, scheduledAt, ebayAccountId) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'scheduled', scheduledAt, ebayAccountId: ebayAccountId || null, errorMessage: null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Cancels a pending schedule, returning the listing to draft status.
 */
async function unscheduleListing(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'draft', scheduledAt: null },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Returns every scheduled listing (across all users) whose scheduled time
 * has already passed, with its source import's ASIN/product attached.
 * Used by the scheduler job, which runs hourly for everyone.
 */
async function listScheduledDue() {
  const docs = await Listing.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() },
  }).populate('importId');

  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.import = doc.importId ? doc.importId.toObject() : null;
    return serialized;
  });
}

/**
 * Permanently removes a listing document from the database.
 * Scoped to the given user, so one user can never delete another's listing.
 * This should only be called AFTER the eBay listing has been successfully
 * withdrawn (see the DELETE /api/listings/:id route), so ELMS and eBay never
 * disagree about whether a listing is still live.
 */
async function deleteListing(userId, id) {
  const result = await Listing.findOneAndDelete({ _id: id, userId });
  return result ? serialize(result) : null;
}


async function markPublishCreditCharged(userId, id, charged = true) {
  const doc = await Listing.findOneAndUpdate({ _id: id, userId }, { publishCreditCharged: !!charged }, { new: true });
  return doc ? serialize(doc) : null;
}

// A worker (the instant publish, the background runner, the once-a-minute queue) publishes one listing at a time by holding this lease.
// A real publish takes well under this; if the process dies the lease runs out and the queue picks the listing up.
const PUBLISH_LEASE_MS = 10 * 60 * 1000;

/** Takes the right to publish a listing that is "publishing" for the next PUBLISH_LEASE_MS. Null when another worker holds it, or it is no longer "publishing". */
async function acquirePublishLease(userId, id, ms = PUBLISH_LEASE_MS) {
  const now = new Date();
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'publishing', $or: [{ publishLeaseUntil: null }, { publishLeaseUntil: { $lt: now } }] },
    { $set: { publishLeaseUntil: new Date(now.getTime() + ms) } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * The listings the queue may publish: "publishing" for at least minAgeMinutes and held by nobody. A listing that was just claimed is
 * being handled by the request or the runner that claimed it, so the queue leaves it alone; one that has waited (a long line, a restart
 * that lost the runner's memory) is picked up here.
 */
async function listPublishingListings(limit = 50, minAgeMinutes = 0) {
  const now = new Date();
  const query = { status: 'publishing', $or: [{ publishLeaseUntil: null }, { publishLeaseUntil: { $lt: now } }] };
  if (minAgeMinutes > 0) query.publishStartedAt = { $lt: new Date(now.getTime() - minAgeMinutes * 60 * 1000) };
  const docs = await Listing.find(query).sort({ publishStartedAt: 1 }).limit(limit);
  return docs.map(serialize);
}

async function listStalePublishingListings(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const docs = await Listing.find({ status: 'publishing', publishStartedAt: { $lt: cutoff }, $or: [{ publishLeaseUntil: null }, { publishLeaseUntil: { $lt: new Date() } }] }).limit(100);
  return docs.map(serialize);
}

/**
 * Turns ONE stale "publishing" listing into an error, and returns it as it was BEFORE (null when somebody else already did, or a worker
 * took it meanwhile). Only the caller that gets it back gives the credit back, so it is refunded once even if two runs overlap.
 */
async function failStalePublishingListing(userId, id, maxAgeMinutes = 30) {
  const now = new Date();
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'publishing', publishStartedAt: { $lt: new Date(now.getTime() - maxAgeMinutes * 60 * 1000) }, $or: [{ publishLeaseUntil: null }, { publishLeaseUntil: { $lt: now } }] },
    { $set: { status: 'error', errorMessage: 'Publish job was interrupted before completion. Please retry.', publishCompletedAt: now, publishErrorDetails: { code: 'PUBLISH_JOB_INTERRUPTED' }, publishCreditCharged: false, publishLeaseUntil: null } },
    { new: false }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Where a few listings are in their publish (status, and the reason when it failed), for the page that watches a background
 * publish. Only this user's listings; at most 100 ids.
 */
async function getListingStatuses(userId, ids) {
  const clean = (Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter((id) => /^[a-f0-9]{24}$/i.test(id)).slice(0, 100);
  if (!clean.length) return [];
  const docs = await Listing.find({ userId, _id: { $in: clean } }).select('status errorMessage ebayListingId title').lean();
  return docs.map((d) => ({ id: String(d._id), status: d.status, error_message: d.errorMessage || null, ebay_listing_id: d.ebayListingId || null, title: d.title || null }));
}

async function recoverStalePublishingListings(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  return Listing.updateMany(
    { status: 'publishing', publishStartedAt: { $lt: cutoff } },
    { $set: { status: 'error', errorMessage: 'Publish job was interrupted before completion. Please retry.', publishCompletedAt: new Date(), publishErrorDetails: { code: 'PUBLISH_JOB_INTERRUPTED' }, publishCreditCharged: false, publishLeaseUntil: null } }
  );
}

module.exports = {
  createListing,
  upsertDraft,
  upsertCjDraft,
  upsertAliexpressDraft,
  getListingById,
  getListingsForDelete,
  deleteListingsMany,
  getListingsByIds,
  listDraftAmazonLinks,
  claimListingForPublishing,
  claimScheduledForPublishing,
  markPublishCreditCharged,
  acquirePublishLease,
  listPublishingListings,
  listStalePublishingListings,
  failStalePublishingListing,
  recoverStalePublishingListings,
  getListingStatuses,
  getListingBySku,
  listListingsBySku,
  listListingsBySkus,
  findListingInStore,
  findCjListingInStore,
  findAliexpressListingInStore,
  listListings,
  listListingsPage,
  listListingIds,
  listRowsByIds,
  summarizeLiveListings,
  getListingFull,
  eachListingChunk,
  pageOptions,
  pageQuery,
  listingProfitAmount,
  claimAfterStoreConnected,
  _resetClaimMemory: () => claimClean.clear(),
  clearVeroCache,
  listListingsByStatuses,
  countListingsByStatus,
  listingStatusBreakdown,
  updateListing,
  markPublished,
  markError,
  markPaused,
  resetErrorToDraft,
  markEnded,
  restockListing,
  listPublishedListings,
  updateListingSettings,
  updateListingStats,
  buildSettingsUpdate,
  deleteListing,
  scheduleListing,
  unscheduleListing,
  listScheduledDue,
  serialize,
  withImportFallback,
  compactVariants,
};
