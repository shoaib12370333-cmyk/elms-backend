/**
 * Clones an existing, already-categorized Amazon Listing (+ its Import) straight into another user's Drafts - no Easyparser
 * or Canopy call, no credit charge. Used by two features that both want the same thing, "a ready-to-list draft, right now":
 *  - the admin's own "push listings" tool (routes/admin.js), free, any target user, any count;
 *  - the paid, self-serve "Buy Listings" tab (routes/listingPacks.js), gated behind a CashTap payment.
 *
 * A Listing only ever gets a real eBay categoryId once a seller has actually placed it (AI suggestion, eBay's own category
 * search, or a manual pick) - it is never part of the raw Amazon scrape. So "categoryId is set" is exactly "this is a real,
 * ready-to-list product", and cloning one is never a guess: title, images, description, specs and the clickable Amazon link
 * all come from a listing a real seller already finished setting up.
 */
const Listing = require('../models/schemas/Listing');
const Import = require('../models/schemas/Import');
const { createImport, updateImportImages } = require('../models/importsModel');
const { upsertDraft, findListingInStore } = require('../models/listingsModel');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { alreadyListedMessage } = require('./extensionService');

// How far back the source pool reaches. Categorized Amazon listings created platform-wide in this window are the "ready to
// list" pool a clone is drawn from - fresh enough that the product is still likely to be in stock, and (per the numbers
// checked when this was designed - about 8,000 in 7 days, and growing) large enough that a draw of even ~1,000 rarely
// repeats the same product twice in a row.
const POOL_WINDOW_DAYS = 7;

/** Runs `worker` over `items` with at most `limit` running at once, returning results in the same order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

/** Fisher-Yates, in place. Not used for anything security-sensitive - just "don't hand out the same 1,000 products in the same order every time". */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * One random candidate per distinct ASIN, platform-wide, from the last POOL_WINDOW_DAYS - excluding ASINs the target
 * already owns (any status, any store) and, since cloning your own listing back to yourself is meaningless, listings that
 * already belong to the target user.
 */
async function candidatePool({ excludeUserId, excludeSkus = [] } = {}) {
  const since = new Date(Date.now() - POOL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await Listing.find(
    { sourcePlatform: 'amazon', categoryId: { $ne: null }, importId: { $ne: null }, createdAt: { $gte: since } },
    { sku: 1, importId: 1, userId: 1 }
  ).lean();
  const excluded = new Set((excludeSkus || []).map((s) => String(s || '').toUpperCase()).filter(Boolean));
  const bySku = new Map();
  for (const row of rows) {
    const sku = String(row.sku || '').toUpperCase();
    if (!sku || excluded.has(sku) || bySku.has(sku)) continue;
    if (excludeUserId && String(row.userId) === String(excludeUserId)) continue;
    bySku.set(sku, row);
  }
  return [...bySku.values()];
}

/** Clones one candidate row (from candidatePool) into a fresh draft for targetUserId. Returns null when it was skipped (already owned, or the source rows vanished in the meantime). */
async function cloneOneListing(row, targetUserId) {
  const [sourceListing, sourceImport] = await Promise.all([
    Listing.findById(row._id),
    Import.findById(row.importId),
  ]);
  if (!sourceListing || !sourceImport || !sourceListing.categoryId) return null;

  const raw = sourceImport.product && typeof sourceImport.product === 'object' ? sourceImport.product : {};
  const asin = raw.asin || sourceImport.asin || sourceListing.sku;
  // The original Amazon CDN image URLs (never this store's own re-hosted copies, which are one seller's ephemeral local
  // files - see services/imageStorageService.js) - stable regardless of who imported it first or whether their upload
  // survived a later deploy.
  const images = (Array.isArray(raw.images) && raw.images.length ? raw.images : sourceListing.images || []).slice(0, 24);

  const activeEbayAccount = await getActiveEbayAccount(targetUserId);
  const already = asin ? alreadyListedMessage(await findListingInStore(targetUserId, asin, activeEbayAccount?.id || null), activeEbayAccount) : null;
  if (already) return null;

  const importRecord = await createImport(
    targetUserId,
    {
      asin,
      title: sourceListing.title || raw.title || null,
      price: sourceListing.amazonPrice != null ? sourceListing.amazonPrice : (raw.price ?? null),
      currency: sourceListing.currency || raw.currency || 'USD',
      images,
    },
    sourceListing.sellPrice,
    sourceImport.amazonUrl || null,
    activeEbayAccount?.id || null
  );
  if (images.length) await updateImportImages(targetUserId, importRecord.id, images);

  const draft = await upsertDraft(targetUserId, {
    importId: importRecord.id,
    ebayAccountId: activeEbayAccount?.id || null,
    marketplaceId: activeEbayAccount?.marketplaceId || null,
    sku: sourceListing.sku,
    title: sourceListing.title,
    mainImage: images[0] || sourceListing.mainImage || null,
    images,
    sellPrice: sourceListing.sellPrice,
    markupPercent: sourceListing.markupPercent,
    currency: sourceListing.currency,
    quantity: 1,
    categoryId: sourceListing.categoryId,
    description: sourceListing.description,
    bulletPoints: sourceListing.bulletPoints,
    specifications: sourceListing.specifications,
    ebayAspects: sourceListing.ebayAspects,
    amazonPrice: sourceListing.amazonPrice,
    marginAmount: sourceListing.marginAmount,
    pricingRule: sourceListing.pricingRule,
  });
  return { draft, sku: sourceListing.sku };
}

/**
 * Clones up to `count` random, distinct-ASIN, category-ready listings platform-wide into targetUserId's Drafts. No credit
 * is charged and no Easyparser/Canopy call is made either way - the caller (the admin push route, or the listing-pack
 * grant) decides separately whether/how this was paid for.
 */
async function pushRandomListings({ targetUserId, count }) {
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  if (!wanted) return { requested: 0, poolSize: 0, pushed: 0 };

  const existingSkus = (await Listing.find({ userId: targetUserId }, { sku: 1 }).lean()).map((l) => l.sku);
  const pool = shuffle(await candidatePool({ excludeUserId: targetUserId, excludeSkus: existingSkus }));
  const picked = pool.slice(0, wanted);

  const results = await mapWithConcurrency(picked, 8, (row) => cloneOneListing(row, targetUserId).catch((err) => {
    console.warn('listing clone failed for sku ' + row.sku + ':', err.message);
    return null;
  }));
  const pushed = results.filter(Boolean).length;
  return { requested: wanted, poolSize: pool.length, pushed };
}

module.exports = { POOL_WINDOW_DAYS, candidatePool, cloneOneListing, pushRandomListings, mapWithConcurrency };
