const Listing = require('./schemas/Listing');

/**
 * Creates a new draft listing (before it's published to eBay), for a specific user.
 */
async function createListing(userId, { importId, ebayAccountId, sku, title, mainImage, images, sellPrice, currency, quantity, categoryId }) {
  const doc = await Listing.create({
    userId,
    importId: importId || null,
    ebayAccountId: ebayAccountId || null,
    sku,
    title: title || null,
    mainImage: mainImage || null,
    images: Array.isArray(images) ? images.slice(0, 50) : [],
    sellPrice: sellPrice ?? null,
    currency: currency || 'USD',
    quantity: quantity ?? 1,
    categoryId: categoryId || null,
    status: 'draft',
  });
  return serialize(doc);
}

/**
 * Creates or updates a draft listing for the given user, keyed by SKU
 * (which is derived from the Amazon ASIN, e.g. "AMZ-B0EXAMPLE"). This is
 * called automatically every time a product is fetched, so re-fetching the
 * same Amazon product refreshes its existing draft instead of creating a
 * duplicate. Only listings still in "draft" status are touched this way -
 * if the user has already published, errored, or ended this SKU, re-fetching
 * the same product does NOT overwrite that listing's status or eBay IDs.
 */
async function upsertDraft(userId, { importId, sku, title, mainImage, images, sellPrice, currency, quantity, categoryId }) {
  const existing = await Listing.findOne({ userId, sku });

  if (existing && existing.status !== 'draft') {
    // Don't silently touch a listing that's already live/errored/ended -
    // just return it as-is so the caller knows a non-draft version exists.
    return serialize(existing);
  }

  const update = {
      userId,
      importId: importId || null,
      sku,
      title: title || null,
      mainImage: mainImage || null,
      sellPrice: sellPrice ?? null,
      currency: currency || 'USD',
      quantity: quantity ?? 1,
      categoryId: categoryId || null,
      status: 'draft',
    };
    if (!existing || !Array.isArray(existing.images) || existing.images.length === 0) {
      update.images = Array.isArray(images) ? images.slice(0, 50) : [];
    }

  const doc = await Listing.findOneAndUpdate(
    { userId, sku },
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

async function listListings(userId, status) {
  const query = status ? { userId, status } : { userId };
  const docs = await Listing.find(query).populate('importId').populate('ebayAccountId').sort({ updatedAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.variant_count = Array.isArray(doc.importId?.product?.variants)
      ? doc.importId.product.variants.length || 1
      : 1;
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
  if (fields.mainImage !== undefined) update.mainImage = fields.mainImage;
  if (fields.images !== undefined) {
    update.imagesCustomized = true;
    update.images = Array.from(new Set((Array.isArray(fields.images) ? fields.images : [])
      .map((url) => String(url || '').trim())
      .filter((url) => /^https?:\/\//i.test(url)))).slice(0, 50);
  }
  if (fields.sellPrice !== undefined) update.sellPrice = fields.sellPrice;
  if (fields.currency !== undefined) update.currency = fields.currency;
  if (fields.quantity !== undefined) update.quantity = fields.quantity;
  if (fields.categoryId !== undefined) update.categoryId = fields.categoryId;

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
    serialized.amazon_price = doc.importId?.amazonPrice ?? null;
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
    sku: obj.sku,
    title: obj.title,
    main_image: obj.mainImage,
    images: Array.isArray(obj.images) ? obj.images : [],
    images_customized: !!obj.imagesCustomized,
    sell_price: obj.sellPrice,
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
  updateListing,
  markPublished,
  markError,
  resetErrorToDraft,
  markEnded,
  listPublishedListings,
  deleteListing,
  scheduleListing,
  unscheduleListing,
  listScheduledDue,
};
