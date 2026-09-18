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
  const existing = await Listing.findOne({ userId, sku: normalizedSku });

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
    { userId, sku: normalizedSku },
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

async function getListingBySku(userId, sku) {
  const doc = await Listing.findOne({ sku, userId });
  return doc ? serialize(doc) : null;
}

async function listListingsByStatuses(userId, statuses = []) {
  const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter(Boolean))];
  const query = cleanStatuses.length ? { userId, status: { $in: cleanStatuses } } : { userId };
  const docs = await Listing.find(query)
    .populate('importId')
    .populate('ebayAccountId')
    .sort({ updatedAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    return serialized;
  });
}

async function countListingsByStatus(userId, status) {
  return Listing.countDocuments({ userId, status });
}

async function listListings(userId, status) {
  const query = status ? { userId, status } : { userId };
  const docs = await Listing.find(query).populate('importId').populate('ebayAccountId').sort({ updatedAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    return serialized;
  });
}

/**
 * Updates any editable fields on a draft listing before it's published.
 * Only fields that are provided (not undefined) are updated. Scoped to the
 * given user so one user can never edit another's listing.
 */
async function updateListing(userId, id, fields) {
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
  if (fields.markDraftCustomized !== false) update.draftCustomized = true;

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
    // The last Amazon price we saw for this product (used by the price
    // monitor as the baseline to detect a change against).
    serialized.amazon_price = normalizeAmazonPrice(doc.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.amazonPrice) ?? normalizeAmazonPrice(doc.importId?.product?.price);
    return serialized;
  });
}

/**
 * Converts a Mongoose document into the plain shape the rest of the app expects.
 */
function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId ? obj.userId.toString() : null,
    import_id: obj.importId ? obj.importId.toString() : null,
    ebay_account_id: obj.ebayAccountId ? obj.ebayAccountId.toString() : null,
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
  deleteListing,
  scheduleListing,
  unscheduleListing,
  listScheduledDue,
};
