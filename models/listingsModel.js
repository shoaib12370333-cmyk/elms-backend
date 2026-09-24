const Listing = require('./schemas/Listing');
const { normalizeAsinSku, requireAsinSku } = require('../services/skuService');

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
async function createListing(userId, { importId, ebayAccountId, marketplaceId, sku, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount, repricingEnabled }) {
  const normalizedAmazonPrice = normalizeAmazonPrice(amazonPrice);
  const normalizedSku = requireAsinSku(sku, 'listing');
  const doc = await Listing.create({
    userId,
    importId: importId || null,
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
async function upsertDraft(userId, { importId, ebayAccountId, marketplaceId, sku, title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, description, bulletPoints, specifications, ebayAspects, amazonPrice, marginAmount }) {
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
      sku: normalizedSku,
      ...(sellerEdited ? {} : {
        title: title || null,
        mainImage: mainImage || null,
        sellPrice: sellPrice ?? null,
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
    { $set: { status: 'publishing', publishStartedAt: new Date(), publishCompletedAt: null, errorMessage: null }, $inc: { publishAttempts: 1 } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** Atomically takes a due scheduled listing for publishing (scheduled -> publishing). Null if it is no longer scheduled. */
async function claimScheduledForPublishing(userId, id) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId, status: 'scheduled' },
    { $set: { status: 'publishing', publishStartedAt: new Date(), publishCompletedAt: null, errorMessage: null }, $inc: { publishAttempts: 1 } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

async function getListingBySku(userId, sku) {
  const doc = await Listing.findOne({ sku, userId });
  return doc ? serialize(doc) : null;
}

async function listListingsByStatuses(userId, statuses = [], accountId = null) {
  const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter(Boolean))];
  await claimUnassignedListings(userId, accountId);
  const query = cleanStatuses.length ? { userId, status: { $in: cleanStatuses } } : { userId };
  if (accountId) query.ebayAccountId = accountId;
  const docs = await Listing.find(query)
    .populate('importId')
    .populate('ebayAccountId')
    .sort({ updatedAt: -1 });
  const soldByListing = await getSoldByListing(userId);
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    serialized.asin = doc.importId?.asin || null;
    serialized.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
    serialized.sold_count = soldByListing.get(String(doc._id)) || 0;
    return withImportFallback(serialized, doc);
  });
}

/** Drafts made before description/bullets/specs were copied onto the listing read them from the linked import. */
function withImportFallback(serialized, doc) {
  const p = doc.importId?.product;
  if (!p) return serialized;
  serialized.brand = String(p.brand || '');
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
    const orphans = await Listing.find({ userId, ebayAccountId: null }).populate('importId').lean();
    if (!orphans.length) return 0;
    const EbayAccount = require('./schemas/EbayAccount');
    const accounts = await EbayAccount.find({ userId }).sort({ createdAt: 1 }).lean();
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

/** Units sold per listing, from the synced eBay orders. */
async function getSoldByListing(userId) {
  try {
    const Order = require('./schemas/Order');
    const mongoose = require('mongoose');
    const rows = await Order.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(String(userId)), listingId: { $ne: null } } },
      { $group: { _id: '$listingId', sold: { $sum: { $ifNull: ['$quantity', 1] } } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.sold]));
  } catch (_) {
    return new Map();
  }
}

async function listListings(userId, status, accountId = null) {
  await claimUnassignedListings(userId, accountId);
  const query = status ? { userId, status } : { userId };
  if (accountId) query.ebayAccountId = accountId;
  const docs = await Listing.find(query).populate('importId').populate('ebayAccountId').sort({ updatedAt: -1 });
  const soldByListing = await getSoldByListing(userId);
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    serialized.asin = doc.importId?.asin || null;
    serialized.supplier_country = supplierCountryFromUrl(doc.importId?.amazonUrl);
    serialized.sold_count = soldByListing.get(String(doc._id)) || 0;
    return withImportFallback(serialized, doc);
  });
}

/**
 * Updates any editable fields on a draft listing before it's published.
 * Only fields that are provided (not undefined) are updated. Scoped to the
 * given user so one user can never edit another's listing.
 */
async function updateListing(userId, id, fields) {
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
  if (fields.amazonPrice !== undefined) {
    const sourcePrice = normalizeAmazonPrice(fields.amazonPrice);
    if (sourcePrice !== null) update.amazonPrice = sourcePrice;
  }
  if (fields.marginAmount !== undefined) {
    const margin = Number(fields.marginAmount);
    if (Number.isFinite(margin)) update.marginAmount = Number(margin.toFixed(2));
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
  if (Number.isFinite(Number(views))) update.views = Math.max(0, Math.trunc(Number(views)));
  if (Number.isFinite(Number(watchers))) update.watchers = Math.max(0, Math.trunc(Number(watchers)));
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

/**
 * Returns every listing (across all users) currently marked as published,
 * with its source import's ASIN and its owning user's ID attached.
 * Used by the stock monitor, which runs for everyone, not one user at a time.
 */
/**
 * Returns every listing currently marked as published, with its source
 * import's ASIN attached - used by the stock monitor. If userId is given,
 * only that user's published listings are returned (used by the per-user
 * scheduled stock check).
 */
async function listPublishedListings(userId) {
  const query = { status: 'published' };
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
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    import_id: idString(obj.importId),
    ebay_account_id: idString(obj.ebayAccountId),
  marketplace_id: obj.marketplaceId || null,
    sku: obj.sku,
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

async function listPublishingListings(limit = 50) {
  const docs = await Listing.find({ status: 'publishing' }).sort({ publishStartedAt: 1 }).limit(limit);
  return docs.map(serialize);
}

async function listStalePublishingListings(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const docs = await Listing.find({ status: 'publishing', publishStartedAt: { $lt: cutoff } }).limit(100);
  return docs.map(serialize);
}

async function recoverStalePublishingListings(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  return Listing.updateMany(
    { status: 'publishing', publishStartedAt: { $lt: cutoff } },
    { $set: { status: 'error', errorMessage: 'Publish job was interrupted before completion. Please retry.', publishCompletedAt: new Date(), publishErrorDetails: { code: 'PUBLISH_JOB_INTERRUPTED' }, publishCreditCharged: false } }
  );
}

module.exports = {
  createListing,
  upsertDraft,
  getListingById,
  claimListingForPublishing,
  claimScheduledForPublishing,
  markPublishCreditCharged,
  listPublishingListings,
  listStalePublishingListings,
  recoverStalePublishingListings,
  getListingBySku,
  listListings,
  listListingsByStatuses,
  countListingsByStatus,
  updateListing,
  markPublished,
  markError,
  markPaused,
  resetErrorToDraft,
  markEnded,
  listPublishedListings,
  updateListingSettings,
  updateListingStats,
  buildSettingsUpdate,
  deleteListing,
  scheduleListing,
  unscheduleListing,
  listScheduledDue,
  serialize,
};
