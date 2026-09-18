/**
 * Central eBay marketplace configuration for ELMS.
 * Values are based on eBay's current REST marketplace/locale documentation.
 */
const MARKETPLACES = Object.freeze({
  EBAY_US: { currency: 'USD', country: 'US', locale: 'en-US' },
  EBAY_AT: { currency: 'EUR', country: 'AT', locale: 'de-AT' },
  EBAY_AU: { currency: 'AUD', country: 'AU', locale: 'en-AU' },
  EBAY_BE: { currency: 'EUR', country: 'BE', locale: 'nl-BE', locales: ['nl-BE', 'fr-BE'] },
  EBAY_CA: { currency: 'CAD', country: 'CA', locale: 'en-CA', locales: ['en-CA', 'fr-CA'] },
  EBAY_CH: { currency: 'CHF', country: 'CH', locale: 'de-CH' },
  EBAY_DE: { currency: 'EUR', country: 'DE', locale: 'de-DE' },
  EBAY_ES: { currency: 'EUR', country: 'ES', locale: 'es-ES' },
  EBAY_FR: { currency: 'EUR', country: 'FR', locale: 'fr-FR' },
  EBAY_GB: { currency: 'GBP', country: 'GB', locale: 'en-GB' },
  EBAY_HK: { currency: 'HKD', country: 'HK', locale: 'zh-HK' },
  EBAY_IE: { currency: 'EUR', country: 'IE', locale: 'en-IE' },
  EBAY_IT: { currency: 'EUR', country: 'IT', locale: 'it-IT' },
  EBAY_MY: { currency: 'MYR', country: 'MY', locale: 'en-US' },
  EBAY_NL: { currency: 'EUR', country: 'NL', locale: 'nl-NL' },
  EBAY_PH: { currency: 'PHP', country: 'PH', locale: 'en-PH' },
  EBAY_PL: { currency: 'PLN', country: 'PL', locale: 'pl-PL' },
  EBAY_SG: { currency: 'SGD', country: 'SG', locale: 'en_US' },
  EBAY_TW: { currency: 'TWD', country: 'TW', locale: 'zh-TW' },
});

function normalizeMarketplaceId(value) {
  return String(value || 'EBAY_US').trim().toUpperCase();
}

function getMarketplaceConfig(value) {
  return MARKETPLACES[normalizeMarketplaceId(value)] || null;
}

function assertSupportedMarketplace(value) {
  const id = normalizeMarketplaceId(value);
  if (!MARKETPLACES[id]) {
    throw new Error(`Unsupported eBay marketplace "${id}". Select a supported eBay marketplace before publishing.`);
  }
  return id;
}

function getMarketplaceLocale(value) {
  return getMarketplaceConfig(value)?.locale || null;
}

module.exports = {
  MARKETPLACES,
  normalizeMarketplaceId,
  getMarketplaceConfig,
  getMarketplaceLocale,
  assertSupportedMarketplace,
};
