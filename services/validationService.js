/**
 * Reusable input validation helpers. These exist so routes can reject
 * obviously-malformed input early (before wasting a credit, an external
 * API call, or hitting the database) with a clear error message, instead
 * of a generic downstream failure or - worse - silently accepting garbage.
 */

const { getMarketplaceConfig } = require('../config/ebayMarketplaces');

const AMAZON_URL_PATTERN = /^https?:\/\/(www\.)?amazon\.[a-z.]{2,10}\//i;

/**
 * Checks that a string looks like a real Amazon product URL. This is a
 * shape check, not a guarantee the page exists - the actual fetch will
 * still fail cleanly for a bad/nonexistent link, but this catches typos,
 * non-Amazon URLs, and empty/garbage input immediately.
 */
function isValidAmazonUrl(url) {
  return typeof url === 'string' && AMAZON_URL_PATTERN.test(url.trim());
}

/**
 * Checks that a value is a valid MongoDB ObjectId shape (24 hex
 * characters) - used to reject obviously-invalid IDs in route params
 * before they even reach a database query.
 */
function isValidObjectIdString(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

/**
 * Checks that a value is a positive, finite number - used for prices,
 * quantities, and similar numeric fields.
 */
function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

// Only enforced for eBay marketplaces that have one clear, well-known matching Amazon site.
// Marketplaces without a real equivalent (eBay Austria/Switzerland/Ireland/Hong Kong/Belgium/
// Poland/Malaysia/Philippines/Taiwan - normally sourced from amazon.de, amazon.com, etc.
// regardless) are left unrestricted rather than guessing a mapping that would wrongly block
// a perfectly normal import.
const COUNTRY_TO_AMAZON_DOMAIN = {
  US: 'amazon.com', GB: 'amazon.co.uk', CA: 'amazon.ca', DE: 'amazon.de', FR: 'amazon.fr',
  IT: 'amazon.it', ES: 'amazon.es', AU: 'amazon.com.au', NL: 'amazon.nl', SG: 'amazon.sg',
};

/**
 * Makes sure an Amazon link actually matches the store (eBay marketplace) it's being
 * imported into - a UK store should only import from amazon.co.uk, a US store only from
 * amazon.com, and so on. This stops the common mix-up of pasting a .com link while a UK
 * (or other) store is selected, which used to silently create a draft priced and sourced
 * from the wrong country. Does nothing (no error) when no active store is given, or when
 * that store's marketplace has no single matching Amazon site (see COUNTRY_TO_AMAZON_DOMAIN).
 *
 * @param {string} amazonUrl
 * @param {string|null} marketplaceId - the active eBay store's marketplaceId, e.g. 'EBAY_GB'
 */
function assertAmazonMatchesStore(amazonUrl, marketplaceId) {
  if (!marketplaceId) return;
  const storeCountry = getMarketplaceConfig(marketplaceId)?.country;
  const expectedDomain = storeCountry && COUNTRY_TO_AMAZON_DOMAIN[storeCountry];
  if (!expectedDomain) return;
  // Required lazily (not at module load) so every unrelated caller of this file's other
  // validators doesn't also pull in canopyAmazonService's axios/retryService dependency.
  const { detectCountryFromUrl } = require('./canopyAmazonService');
  const linkCountry = detectCountryFromUrl(amazonUrl);
  if (linkCountry === storeCountry) return;
  const err = new Error(`This store is set to ${storeCountry} - please paste a link from ${expectedDomain} (this link looks like it's from a different Amazon site).`);
  err.statusCode = 400;
  throw err;
}

module.exports = { isValidAmazonUrl, isValidObjectIdString, isPositiveNumber, assertAmazonMatchesStore, COUNTRY_TO_AMAZON_DOMAIN };
