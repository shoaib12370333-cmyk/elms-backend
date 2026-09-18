const assert = require('node:assert/strict');
const {
  MARKETPLACES,
  normalizeMarketplaceId,
  getMarketplaceConfig,
  getMarketplaceLocale,
  assertSupportedMarketplace,
} = require('../config/ebayMarketplaces');

const expected = {
  EBAY_US: ['USD', 'US', 'en-US'],
  EBAY_GB: ['GBP', 'GB', 'en-GB'],
  EBAY_DE: ['EUR', 'DE', 'de-DE'],
  EBAY_FR: ['EUR', 'FR', 'fr-FR'],
  EBAY_CA: ['CAD', 'CA', 'en-CA'],
  EBAY_AU: ['AUD', 'AU', 'en-AU'],
  EBAY_IT: ['EUR', 'IT', 'it-IT'],
  EBAY_ES: ['EUR', 'ES', 'es-ES'],
  EBAY_NL: ['EUR', 'NL', 'nl-NL'],
  EBAY_AT: ['EUR', 'AT', 'de-AT'],
  EBAY_CH: ['CHF', 'CH', 'de-CH'],
  EBAY_IE: ['EUR', 'IE', 'en-IE'],
  EBAY_PL: ['PLN', 'PL', 'pl-PL'],
  EBAY_PH: ['PHP', 'PH', 'en-PH'],
  EBAY_HK: ['HKD', 'HK', 'zh-HK'],
  EBAY_MY: ['MYR', 'MY', 'en-US'],
  EBAY_SG: ['SGD', 'SG', 'en_US'],
  EBAY_TW: ['TWD', 'TW', 'zh-TW'],
};

for (const [id, [currency, country, locale]] of Object.entries(expected)) {
  const cfg = getMarketplaceConfig(id);
  assert.ok(cfg, `${id} should be configured`);
  assert.equal(cfg.currency, currency);
  assert.equal(cfg.country, country);
  assert.equal(cfg.locale, locale);
  assert.equal(getMarketplaceLocale(id), locale);
  assert.equal(assertSupportedMarketplace(id), id);
}

assert.equal(normalizeMarketplaceId(' ebay_gb '), 'EBAY_GB');
assert.equal(normalizeMarketplaceId(undefined), 'EBAY_US');
assert.throws(() => assertSupportedMarketplace('EBAY_FAKE'), /Unsupported eBay marketplace/);
assert.ok(Object.keys(MARKETPLACES).length >= 18);

console.log('Marketplace configuration tests passed.');
