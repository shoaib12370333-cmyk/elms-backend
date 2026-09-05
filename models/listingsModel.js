const Listing = require('./schemas/Listing');

/**
 * Creates a new draft listing (before it's published to eBay), for a specific user.
 */
async function createListing(userId, { importId, sku, title, mainImage, sellPrice, quantity, categoryId }) {
  const doc = await Listing.create({
    userId,
    importId: importId || null,
    sku,
    title: title || null,
    mainImage: mainImage || null,
    sellPrice: sellPrice ?? null,
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
async function upsertDraft(userId, { importId, sku, title, mainImage, sellPrice, quantity, categoryId }) {
  const existing = await Listing.findOne({ userId, sku });

  if (existing && existing.status !== 'draft') {
    // Don't silently touch a listing that's already live/errored/ended -
    // just return it as-is so the caller knows a non-draft version exists.
    return serialize(existing);
  }

  const doc = await Listing.findOneAndUpdate(
    { userId, sku },
    {
      userId,
      importId: importId || null,
      sku,
      title: title || null,
      mainImage: mainImage || null,
      sellPrice: sellPrice ?? null,
      quantity: quantity ?? 1,
      categoryId: categoryId || null,
      status: 'draft',
    },
    { new: true, upsert: true }
  );
  return serialize(doc);
}

async function getListingById(userId, id) {
  const doc = await Listing.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

async function getListingBySku(userId, sku) {
  const doc = await Listing.findOne({ sku, userId });
  return doc ? serialize(doc) : null;
}

async function listListings(userId, status) {
  const query = status ? { userId, status } : { userId };
  const docs = await Listing.find(query).populate('importId').sort({ updatedAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.amazon_url = doc.importId?.amazonUrl || null;
    serialized.variant_count = Array.isArray(doc.importId?.product?.variants)
      ? doc.importId.product.variants.length || 1
      : 1;
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
  if (fields.sellPrice !== undefined) update.sellPrice = fields.sellPrice;
  if (fields.quantity !== undefined) update.quantity = fields.quantity;
  if (fields.categoryId !== undefined) update.categoryId = fields.categoryId;

  const doc = await Listing.findOneAndUpdate({ _id: id, userId }, update, { new: true });
  return doc ? serialize(doc) : null;
}

/**
 * Marks a listing as successfully published, storing eBay's returned IDs.
 */
async function markPublished(userId, id, { offerId, listingId }) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    {
      status: 'published',
      ebayOfferId: offerId || null,
      ebayListingId: listingId || null,
      errorMessage: null,
    },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/**
 * Marks a listing as failed to publish, storing the error for display.
 */
async function markError(userId, id, errorMessage) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'error', errorMessage: errorMessage || 'Unknown error' },
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
    sku: obj.sku,
    title: obj.title,
    main_image: obj.mainImage,
    sell_price: obj.sellPrice,
    quantity: obj.quantity,
    category_id: obj.categoryId,
    ebay_offer_id: obj.ebayOfferId,
    ebay_listing_id: obj.ebayListingId,
    status: obj.status,
    scheduled_at: obj.scheduledAt,
    error_message: obj.errorMessage,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

/**
 * Marks a draft (or previously errored) listing as scheduled to publish
 * automatically at the given time. Scoped to the given user.
 */
async function scheduleListing(userId, id, scheduledAt) {
  const doc = await Listing.findOneAndUpdate(
    { _id: id, userId },
    { status: 'scheduled', scheduledAt, errorMessage: null },
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

module.exports = {
  createListing,
  upsertDraft,
  getListingById,
  getListingBySku,
  listListings,
  updateListing,
  markPublished,
  markError,
  markEnded,
  listPublishedListings,
  deleteListing,
  scheduleListing,
  unscheduleListing,
  listScheduledDue,
};
