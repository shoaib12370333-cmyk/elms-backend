const express = require('express');
const router = express.Router();
const { fetchProductByUrl, extractAsinFromUrl, detectCountryFromUrl } = require('../services/canopyAmazonService');
const { createImport, updateImportImages } = require('../models/importsModel');
const { upsertDraft, findListingInStore } = require('../models/listingsModel');
const { hasCredits } = require('../models/usersModel');
const { withCredits } = require('../services/creditService');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidAmazonUrl, assertAmazonMatchesStore } = require('../services/validationService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { materializeImageUrls } = require('../services/imageStorageService');
const { requireAsinSku } = require('../services/skuService');
const { getCachedProduct, setCachedProduct } = require('../services/productCacheService');
const { currencyForAmazonUrl } = require('../config/amazonDomains');
const { convertAmount } = require('../services/currencyService');
const { storeForImport, assertStoreForImport, bulkCostFor, alreadyListedMessage } = require('../services/extensionService');

const MAX_ACTIVE_BULK_JOBS = 3; // background imports one person can have running at once
const MARKUP_MIN = -99;
const MARKUP_MAX = 1000;

/** The markup % of a request: null when it is not a number in the range the import page allows (empty counts as 0%). */
function readMarkup(value) {
  if (value === '' || value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= MARKUP_MIN && n <= MARKUP_MAX ? n : null;
}

/**
 * Puts the product's price in the currency of the Amazon site it came from - the currency every later step (the draft, the
 * profit, the price that goes to eBay) takes it to be in. Easyparser used to answer an amazon.co.uk product in USD, so a
 * price of 8.00 GBP was saved as 10.70 and published as 10.70+ GBP. A price that already is in the site's currency is left
 * alone; one in another currency is converted, and when it cannot be (no exchange rate) nothing is saved or charged.
 */
async function alignPriceCurrency(product, sourceUrl) {
  const site = currencyForAmazonUrl(sourceUrl || product.sourceUrl);
  if (!site) return product;
  const have = String(product.currency || '').toUpperCase();
  if (!have || have === site || product.price == null) {
    product.currency = site;
    return product;
  }
  let fx;
  try {
    fx = await convertAmount(product.price, have, site);
  } catch (err) {
    const wrapped = new Error('The price of this product is in ' + have + ' but the Amazon site sells in ' + site + ', and the exchange rate could not be loaded (' + err.message + '). Try again in a minute.');
    wrapped.statusCode = 503;
    throw wrapped;
  }
  product.price = fx.amount;
  product.currency = site;
  return product;
}

/**
 * Saves an already-fetched, normalized product (see canopyAmazonService.normalizeProduct /
 * easyparserAmazonService.normalizeDetail) as an import + draft listing for a user. This is
 * the provider-agnostic half of what used to be fetchAndSaveDraft: fetching the product data
 * is a separate step so it can come from Canopy (single/small-bulk import, below), from
 * Easyparser (the background bulk-job processor, see jobs/bulkImportProcessor.js), or from
 * the browser extension. Spends a credit on success, refunds it if saving fails, so a
 * database hiccup never permanently costs a credit for nothing - same as before.
 * `options.alreadyCharged`: the caller took the credit already (fetchAndSaveDraft charges BEFORE the Amazon lookup), so it is not taken again here.
 *
 * `req` is only used to build absolute image URLs when no BACKEND_PUBLIC_URL/RENDER_EXTERNAL_URL
 * env var is set (see imageStorageService.publicBaseUrl) - the background job passes a minimal
 * stand-in object since it has no real HTTP request.
 */
async function saveProductAsDraft(userId, product, markupPercent, sourceUrl, req, knownActiveEbayAccount, { alreadyCharged = false, cost = ACTION_COSTS.AMAZON_IMPORT } = {}) {
  const activeEbayAccount = knownActiveEbayAccount !== undefined ? knownActiveEbayAccount : await getActiveEbayAccount(userId);
  await alignPriceCurrency(product, sourceUrl); // before the credit is taken: a price that cannot be put right saves nothing
  // A listing that is already live (or paused, scheduled, ended ...) is never changed by an import: refuse before any credit is spent.
  const already = product.asin ? alreadyListedMessage(await findListingInStore(userId, product.asin, activeEbayAccount?.id || null), activeEbayAccount) : null;
  if (already) throw Object.assign(new Error(already), { statusCode: 409, alreadyListed: true });
  // Pays first (nothing is saved without the credit) and gives it back if saving fails.
  const save = async () => {
    let suggestedPrice = null;
    if (product.price != null && markupPercent != null) {
      const markup = Number(markupPercent);
      if (!Number.isNaN(markup)) {
        suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
      }
    }

    const importRecord = await createImport(userId, product, suggestedPrice, sourceUrl, activeEbayAccount?.id || null);
    product.images = product.images?.length
      ? await materializeImageUrls({ urls: product.images, userId, listingId: importRecord.id, req })
      : [];
    await updateImportImages(userId, importRecord.id, product.images || []);
    const sku = requireAsinSku(product.asin, 'Amazon product');
    const draft = await upsertDraft(userId, {
      importId: importRecord.id,
      ebayAccountId: activeEbayAccount?.id || null,
      marketplaceId: activeEbayAccount?.marketplaceId || null,
      sku,
      title: product.title,
      mainImage: (product.images && product.images[0]) || null,
      sellPrice: suggestedPrice ?? product.price,
      markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
      currency: product.currency,
      quantity: 1,
      categoryId: null,
      description: product.description || '',
      bulletPoints: product.bulletPoints || [],
      specifications: product.specifications || [],
      ebayAspects: product.ebayAspects || {},
      amazonPrice: product.price,
      marginAmount: suggestedPrice != null && product.price != null ? Number((suggestedPrice - product.price).toFixed(2)) : null,
    });

    return { product, suggestedPrice, importId: importRecord.id, draft };
  };
  return alreadyCharged ? save() : withCredits(userId, cost, save);
}

/** The store a list of imports goes to: the one the extension chose (must be the user's own), else the active store as always. */
function resolveStore(userId, ebayAccountId) {
  return ebayAccountId === undefined || ebayAccountId === null || ebayAccountId === '' ? getActiveEbayAccount(userId) : storeForImport(userId, ebayAccountId);
}

/** One product = country + ASIN, however the link is written. */
function productKey(url) {
  const asin = extractAsinFromUrl(url);
  return detectCountryFromUrl(url) + ':' + (asin || url);
}

/**
 * Fetches one Amazon product (via Canopy, using a 7-day cache so the same ASIN isn't paid
 * for twice - see services/productCacheService), then saves it as a draft. Shared by both
 * the single-URL and small-bulk (synchronous) routes below.
 */
async function fetchAndSaveDraft(userId, amazonUrl, markupPercent, req, chosenStore, cost = ACTION_COSTS.AMAZON_IMPORT) {
  const activeEbayAccount = chosenStore !== undefined ? chosenStore : await getActiveEbayAccount(userId);
  await assertStoreForImport(activeEbayAccount); // no store at all: only when the admin allows it
  assertAmazonMatchesStore(amazonUrl, activeEbayAccount?.marketplaceId || null);

  const asin = extractAsinFromUrl(amazonUrl);
  const country = detectCountryFromUrl(amazonUrl);

  // A product that is already live (or paused, scheduled, ended ...) is refused from the link alone, before anything is paid or fetched.
  if (asin) {
    const already = alreadyListedMessage(await findListingInStore(userId, asin, activeEbayAccount?.id || null), activeEbayAccount);
    if (already) throw Object.assign(new Error(already), { statusCode: 409, alreadyListed: true });
  }

  // Pays FIRST. The Amazon lookup costs real money, so it must not run for a request whose credit is not there: with the lookup before
  // the charge, a person with one credit could start many requests at once and every one of them would ask Amazon (only one could then
  // pay). The credit is given back if anything fails, as before.
  return withCredits(userId, cost, async () => {
    let product = asin ? await getCachedProduct(asin, country) : null;
    if (!product) {
      product = await fetchProductByUrl(amazonUrl);
      if (product.asin) await setCachedProduct(product.asin, country, product, 'canopy');
    }
    return saveProductAsDraft(userId, product, markupPercent, amazonUrl, req, activeEbayAccount, { alreadyCharged: true });
  });
}

/**
 * POST /api/fetch-product
 * Requires a valid session token and at least one credit (checked before
 * the Amazon API call - admins are never charged and always pass).
 * Body: { amazonUrl: string, markupPercent?: number }
 *
 * Fetches product data from an Amazon link, applies the markup (if given) to
 * calculate a suggested eBay price, and saves the fetch as an import record
 * belonging to the current user. It also automatically saves (or refreshes)
 * a matching draft listing, keyed by the product's ASIN, so the fetched
 * product shows up on the Drafts page and can be published later with one
 * click, without needing to paste the Amazon link again.
 */
router.post('/', requireAuth, async (req, res) => {
  const { amazonUrl, markupPercent } = req.body;

  if (!amazonUrl) {
    return res.status(400).json({ error: 'The amazonUrl field is required.' });
  }
  if (!isValidAmazonUrl(amazonUrl)) {
    return res.status(400).json({ error: 'That does not look like a valid Amazon product URL.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.AMAZON_IMPORT))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

  try {
    const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent, req);
    res.json({ success: true, ...result });
  } catch (err) {
    if (!err.outOfCredits) console.error('fetch-product error:', err.message); // running out of credits is normal, not an error to log
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Something went wrong.',
    });
  }
});

/**
 * GET /api/fetch-product/limits
 * bulkImportMax: the synchronous bulk route's cap (POST /bulk, below).
 * bulkJobMax: the background bulk-job route's much higher cap (POST /bulk-job).
 */
router.get('/limits', requireAuth, async (req, res) => {
  const { bulkImportMax, bulkJobMax } = await require('../models/settingsModel').getLimits();
  res.json({ success: true, bulkImportMax, bulkJobMax, easyparserConfigured: !!process.env.EASYPARSER_API_KEY });
});

/**
 * POST /api/fetch-product/bulk
 * Requires a valid session token.
 * Body: { amazonUrls: string[], markupPercent?: number }
 *
 * Fetches multiple Amazon links one at a time (synchronously, within this one request) and
 * saves each as an import + draft. Capped low (see bulkImportMax, default 25) because it
 * runs entirely inside one HTTP request - for large lists, use POST /bulk-job instead, which
 * runs in the background and can handle far more links without timing out.
 */
router.post('/bulk', requireAuth, async (req, res) => {
  const { amazonUrls, markupPercent, ebayAccountId, source } = req.body;
  const cost = bulkCostFor(source); // an import started from the extension has its own price (Admin -> Credit Costs)

  if (!Array.isArray(amazonUrls) || amazonUrls.length === 0) {
    return res.status(400).json({ success: false, error: 'amazonUrls must be a non-empty array.' });
  }
  const { bulkImportMax } = await require('../models/settingsModel').getLimits();
  if (amazonUrls.length > bulkImportMax) {
    return res.status(400).json({ success: false, error: 'Please import at most ' + bulkImportMax + ' links at a time.', max: bulkImportMax });
  }

  // One credit per product: the same product pasted twice is imported (and charged) once, and the whole list has to be
  // affordable before anything is fetched, so a list never stops half way for lack of credits.
  const uniqueProducts = new Set(amazonUrls.filter((u) => isValidAmazonUrl(u)).map((u) => productKey(String(u).trim())));
  const needed = uniqueProducts.size * cost;
  if (uniqueProducts.size && !(await hasCredits(req.userId, needed))) {
    return res.status(402).json({ success: false, error: `This list has ${uniqueProducts.size} product${uniqueProducts.size === 1 ? '' : 's'} and needs ${needed} credit${needed === 1 ? '' : 's'}. You do not have enough.`, needed });
  }

  let chosenStore;
  try {
    chosenStore = await resolveStore(req.userId, ebayAccountId);
    await assertStoreForImport(chosenStore);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }

  const results = [];
  const done = new Set();

  for (const amazonUrl of amazonUrls) {
    if (!isValidAmazonUrl(amazonUrl)) {
      results.push({ amazonUrl, success: false, error: 'That does not look like a valid Amazon product URL.' });
      continue;
    }
    const key = productKey(String(amazonUrl).trim());
    if (done.has(key)) {
      results.push({ amazonUrl, success: false, skipped: true, error: 'The same product is already in this list. It is imported once and charged once.' });
      continue;
    }
    done.add(key);

    try {
      const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent, req, chosenStore, cost);
      results.push({ amazonUrl, success: true, ...result });
    } catch (err) {
      console.error(`fetch-product/bulk error for ${amazonUrl}:`, err.message);
      results.push({ amazonUrl, success: false, error: err.message || 'Something went wrong.' });
    }
  }

  res.json({ success: true, results });
});

/**
 * POST /api/fetch-product/bulk-job
 * Requires a valid session token and EASYPARSER_API_KEY to be configured on the server.
 * Body: { amazonUrls: string[], markupPercent?: number }
 *
 * For large lists (up to bulkJobMax, default 1000). Unlike POST /bulk, this returns
 * immediately with a job id - the links are fetched and saved in the background by
 * jobs/bulkImportProcessor.js (via Easyparser's Bulk API), so the request never times out
 * and the browser tab can be closed. Poll GET /bulk-job/:id for progress.
 */
router.post('/bulk-job', requireAuth, async (req, res) => {
  const { amazonUrls, markupPercent, ebayAccountId, source } = req.body;
  const cost = bulkCostFor(source); // an import started from the extension has its own price (Admin -> Credit Costs)
  if (!Array.isArray(amazonUrls) || amazonUrls.length === 0) {
    return res.status(400).json({ success: false, error: 'amazonUrls must be a non-empty array.' });
  }
  if (!process.env.EASYPARSER_API_KEY) {
    return res.status(503).json({ success: false, error: 'Large background imports are not configured on the server yet (EASYPARSER_API_KEY is missing).' });
  }
  const markup = readMarkup(markupPercent);
  if (markup === null) {
    return res.status(400).json({ success: false, error: `Markup must be a number between ${MARKUP_MIN}% and ${MARKUP_MAX}%.` });
  }
  const { bulkJobMax } = await require('../models/settingsModel').getLimits();
  if (amazonUrls.length > bulkJobMax) {
    return res.status(400).json({ success: false, error: 'Please import at most ' + bulkJobMax + ' links at a time.', max: bulkJobMax });
  }
  if (!(await hasCredits(req.userId, cost))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  let activeEbayAccount;
  try {
    activeEbayAccount = await resolveStore(req.userId, ebayAccountId);
    await assertStoreForImport(activeEbayAccount);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
  const seen = new Set();
  const items = [];
  const skipped = [];
  for (const amazonUrl of amazonUrls) {
    const url = String(amazonUrl || '').trim();
    if (!url) continue;
    if (!isValidAmazonUrl(url)) { skipped.push({ amazonUrl: url, error: 'Not a valid Amazon product URL.' }); continue; }
    try {
      assertAmazonMatchesStore(url, activeEbayAccount?.marketplaceId || null);
    } catch (err) {
      skipped.push({ amazonUrl: url, error: err.message });
      continue;
    }
    const asin = extractAsinFromUrl(url);
    if (!asin) { skipped.push({ amazonUrl: url, error: 'Could not find an ASIN in that URL.' }); continue; }
    const country = detectCountryFromUrl(url);
    const dedupeKey = country + ':' + asin;
    if (seen.has(dedupeKey)) continue; // same product pasted twice - one item covers it
    seen.add(dedupeKey);
    items.push({ amazonUrl: url, asin, country, status: 'pending' });
  }
  if (!items.length) {
    return res.status(400).json({ success: false, error: 'None of those links look like valid Amazon product links.', skipped });
  }

  // The Easyparser calls of a job are paid for before anything is saved, so nobody can start more work than their credits cover: what
  // their other running imports still have to save counts too, and only a few imports run at once.
  const { createBulkImportJob, activeJobStats } = require('../models/bulkImportJobsModel');
  const active = await activeJobStats(req.userId);
  if (active.jobs >= MAX_ACTIVE_BULK_JOBS) {
    return res.status(429).json({ success: false, error: `You already have ${active.jobs} imports running. Wait for one to finish (or cancel one), then start the next.`, skipped });
  }
  const needed = (active.pendingItems + items.length) * cost;
  if (!(await hasCredits(req.userId, needed))) {
    const others = active.pendingItems ? ` (${active.pendingItems} more from your other imports are still waiting to be saved)` : '';
    return res.status(402).json({ success: false, error: `This list has ${items.length} product${items.length === 1 ? '' : 's'} and needs ${needed} credit${needed === 1 ? '' : 's'} in all${others}. You do not have enough.`, needed, products: items.length, skipped });
  }

  const job = await createBulkImportJob(req.userId, {
    ebayAccountId: activeEbayAccount?.id || null,
    markupPercent: markup,
    source: source === 'extension' ? 'extension' : 'website',
    items,
  });
  res.json({ success: true, jobId: job.id, total: job.total, skipped });
});

/**
 * GET /api/fetch-product/bulk-job/:id - progress for one job (store-scoped: only the
 * user's own jobs are returned).
 * GET /api/fetch-product/bulk-job - the user's recent jobs, newest first.
 */
router.get('/bulk-job/:id', requireAuth, async (req, res) => {
  const { getBulkImportJob } = require('../models/bulkImportJobsModel');
  const job = await getBulkImportJob(req.userId, req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });
  res.json({ success: true, job });
});
router.get('/bulk-job', requireAuth, async (req, res) => {
  const { listBulkImportJobs } = require('../models/bulkImportJobsModel');
  const jobs = await listBulkImportJobs(req.userId);
  res.json({ success: true, jobs });
});

/** POST /api/fetch-product/bulk-job/:id/cancel - stops a job that's still queued/running. */
router.post('/bulk-job/:id/cancel', requireAuth, async (req, res) => {
  const { cancelBulkImportJob } = require('../models/bulkImportJobsModel');
  const job = await cancelBulkImportJob(req.userId, req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found or already finished.' });
  res.json({ success: true, job });
});

/** POST /api/fetch-product/bulk-job/:id/retry - retries this job's failed items. */
router.post('/bulk-job/:id/retry', requireAuth, async (req, res) => {
  try {
    const { retryBulkImportJob } = require('../models/bulkImportJobsModel');
    const job = await retryBulkImportJob(req.userId, req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });
    res.json({ success: true, job });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.saveProductAsDraft = saveProductAsDraft;
module.exports.fetchAndSaveDraft = fetchAndSaveDraft;
module.exports.alignPriceCurrency = alignPriceCurrency;
module.exports.readMarkup = readMarkup;
