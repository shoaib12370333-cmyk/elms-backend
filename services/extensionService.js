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
const ASIN_RE = /^[A-Z0-9]{10}$/;

const frontendUrl = () => String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/+$/, '');
const money = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

/** The user's balance the way the panel shows it: admins have no limit. */
function creditsOf(user) {
  const unlimited = !!user && user.role === 'admin';
  return { balance: unlimited ? null : Number(user && user.creditBalance) || 0, unlimited, importCost: ACTION_COSTS.BROWSER_IMPORT_SCRAPE, bulkImportCost: ACTION_COSTS.AMAZON_IMPORT };
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
function existingOf(listings, accounts) {
  const labels = new Map((accounts || []).map((a) => [a.id, a.label]));
  return (listings || []).slice(0, MAX_EXISTING).map((l) => ({
    id: l.id,
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

  const out = { credits: creditsOf(user), appUrl: frontendUrl(), stores: storesOf(accounts, input.amazonUrl), existing: [], vero: { enabled: false, terms: [], fields: {} } };
  if (ASIN_RE.test(asin)) {
    out.existing = existingOf(await listListingsBySku(input.userId, asin), accounts);
    out.vero = await veroOf(input.userId, input);
  }
  return out;
}

module.exports = { panelInfo, creditsOf, storesOf, existingOf, amazonFit, frontendUrl };
