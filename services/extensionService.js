const { ACTION_COSTS } = require('../config/actionCosts');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');

/**
 * What the browser extension's panel on an Amazon page needs to know before anything is imported - all of it free:
 *
 *   credits    the balance and what one import costs (admins are never charged)
 *   stores     the user's connected eBay stores, each with whether THIS Amazon site fits its marketplace
 *   existing   the listings this user already has for the product's ASIN (SKU = ASIN), in any store and any state
 *   vero       the user's own VeRO words found in the product's title / brand / bullet points
 *
 * The profit maths (fees, break-even, margin) is done in the extension itself from the price on the page.
 */

const MAX_EXISTING = 10;
const MAX_KNOWN_ASINS = 100;
const ASIN_RE = /^[A-Z0-9]{10}$/;

const frontendUrl = () => String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/+$/, '');
const money = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

/** The user's balance the way the panel shows it: admins have no limit. */
function creditsOf(user) {
  const unlimited = !!user && user.role === 'admin';
  return { balance: unlimited ? null : Number(user && user.creditBalance) || 0, unlimited, importCost: ACTION_COSTS.BROWSER_IMPORT_SCRAPE, bulkImportCost: ACTION_COSTS.EXTENSION_BULK_IMPORT };
}

/** Does this Amazon page belong to the store's marketplace? (a UK store takes amazon.co.uk only ...) */
function amazonFit(amazonUrl, marketplaceId) {
  if (!amazonUrl) return { ok: true, message: null };
  try {
    require('./validationService').assertAmazonMatchesStore(amazonUrl, marketplaceId || null);
    return { ok: true, message: null };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function storesOf(accounts, amazonUrl) {
  return (accounts || []).map((a) => {
    const fit = amazonFit(amazonUrl, a.marketplaceId);
    const market = getMarketplaceConfig(a.marketplaceId);
    return { id: a.id, label: a.label, marketplaceId: a.marketplaceId, currency: market ? market.currency : null, isActive: !!a.isActive, amazonOk: fit.ok, amazonMessage: fit.message };
  });
}

/** The listing rows the panel needs (never the whole listing). */
function existingOf(listings, accounts, limit = MAX_EXISTING) {
  const labels = new Map((accounts || []).map((a) => [a.id, a.label]));
  return (listings || []).slice(0, limit).map((l) => ({
    id: l.id,
    asin: l.sku || null,
    status: l.status,
    storeId: l.ebay_account_id || null,
    storeLabel: l.ebay_account_id ? labels.get(l.ebay_account_id) || null : null,
    sellPrice: money(l.sell_price),
    amazonPrice: money(l.amazon_price),
    currency: l.currency || null,
    ebayListingId: l.ebay_listing_id || null,
    updatedAt: l.updated_at || null,
  }));
}

/** VeRO words of the user found in what the product says. Nothing is flagged for a user who saved no words. */
async function veroOf(userId, { title, brand, bulletPoints }) {
  const { getVeroWordsOf } = require('./veroSettingsService');
  const { createMatcher } = require('./veroService');
  const words = await getVeroWordsOf(userId);
  if (!words.length) return { enabled: false, terms: [], fields: {} };
  const found = createMatcher(words).scanListing({ title, brand, bulletPoints: Array.isArray(bulletPoints) ? bulletPoints.slice(0, 30) : [] });
  return { enabled: true, terms: found.terms, fields: found.fields };
}

/**
 * @param {{ userId: string, asin?: string, amazonUrl?: string, title?: string, brand?: string, bulletPoints?: string[] }} input
 */
async function panelInfo(input) {
  const { getUserById } = require('../models/usersModel');
  const { listEbayAccounts } = require('../models/ebayAccountsModel');
  const { listListingsBySku } = require('../models/listingsModel');

  const asin = String(input.asin || '').trim().toUpperCase();
  const [user, accounts] = await Promise.all([getUserById(input.userId), listEbayAccounts(input.userId)]);
  if (!user) return null;

  const out = { credits: creditsOf(user), policy: { importWithoutStore: await importWithoutStoreAllowed() }, appUrl: frontendUrl(), stores: storesOf(accounts, input.amazonUrl), existing: [], vero: { enabled: false, terms: [], fields: {} } };
  if (ASIN_RE.test(asin)) {
    out.existing = existingOf(await listListingsBySku(input.userId, asin), accounts);
    out.vero = await veroOf(input.userId, input);
  }
  return out;
}

/** For product lists (search results): what the user already has for each of these ASINs, in any store. */
async function knownFor(userId, asins) {
  const { listEbayAccounts } = require('../models/ebayAccountsModel');
  const { listListingsBySkus } = require('../models/listingsModel');
  const list = [...new Set((Array.isArray(asins) ? asins : []).map((a) => String(a || '').trim().toUpperCase()).filter((a) => ASIN_RE.test(a)))].slice(0, MAX_KNOWN_ASINS);
  if (!list.length) return [];
  const [accounts, rows] = await Promise.all([listEbayAccounts(userId), listListingsBySkus(userId, list)]);
  return existingOf(rows, accounts, 1000);
}

/** The store an import goes to: the one the extension chose (it must be the user's own), else the active store. */
async function storeForImport(userId, ebayAccountId) {
  const { getActiveEbayAccount, getEbayAccountById } = require('../models/ebayAccountsModel');
  const { isValidObjectIdString } = require('./validationService');
  if (ebayAccountId === undefined || ebayAccountId === null || ebayAccountId === '') return getActiveEbayAccount(userId);
  const store = isValidObjectIdString(String(ebayAccountId)) ? await getEbayAccountById(userId, String(ebayAccountId)) : null;
  if (!store) throw Object.assign(new Error('That eBay store was not found. Pick your store again in the extension.'), { statusCode: 404 });
  return store;
}

/** May imports be made before an eBay store is connected? (Admin -> Settings.) Yes unless switched off; a settings problem never blocks an import. */
async function importWithoutStoreAllowed() {
  try {
    const settings = await require('../models/settingsModel').getSettings();
    return !settings || settings.importWithoutEbayAccount !== false;
  } catch (_) {
    return true;
  }
}

/** Throws (403) for an import that has no eBay store when the admin has switched that off. Runs before anything is paid. */
async function assertStoreForImport(store) {
  if (store || await importWithoutStoreAllowed()) return;
  throw Object.assign(new Error('Connect an eBay store in ELMS first, then import. Nothing was imported and no credit was used.'), { statusCode: 403, code: 'store_required' });
}

/** What one product of a list import costs: an import started from the extension has its own price (Admin -> Credit Costs). */
function bulkCostFor(source) {
  return source === 'extension' ? ACTION_COSTS.EXTENSION_BULK_IMPORT : ACTION_COSTS.AMAZON_IMPORT;
}

// A listing that is no longer a draft is never changed by an import, so importing over it would only spend a credit.
const ALREADY = {
  published: 'is already live on eBay',
  paused: 'is already on eBay (paused)',
  publishing: 'is being published right now',
  scheduled: 'is already scheduled to publish',
  error: 'is already in your Drafts with a publish error - open it there and press Retry',
  ended: 'was ended on eBay - republish it from Live Listings',
};

/** The message for an import that would land on a listing that is not a draft, or null when the import can go ahead. */
function alreadyListedMessage(listing, store) {
  if (!listing || listing.status === 'draft') return null;
  const where = store && store.label ? ' in ' + store.label : '';
  return 'This product ' + (ALREADY[listing.status] || 'already exists as a ' + listing.status + ' listing') + where + '. Nothing was imported and no credit was used.';
}

module.exports = { panelInfo, knownFor, storeForImport, assertStoreForImport, importWithoutStoreAllowed, bulkCostFor, alreadyListedMessage, creditsOf, storesOf, existingOf, amazonFit, frontendUrl, MAX_KNOWN_ASINS };
