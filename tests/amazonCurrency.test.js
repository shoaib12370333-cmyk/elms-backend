// The currency of an imported product comes from the Amazon site it was read from. A product from amazon.com.au that is
// read as USD is converted to AUD a second time when it is published to an Australian store (about 50% too dear).
const assert = require('assert');
const fs = require('fs');
process.env.EASYPARSER_API_KEY = 'test-key';
const { currencyForAmazonUrl, sourceCurrency } = require('../config/amazonDomains');
const { cleanProduct } = require('../routes/browserImport');
const { normalizeDetail } = require('../services/easyparserAmazonService');
const { normalizeProduct } = require('../services/canopyAmazonService');

const cases = {
  'https://www.amazon.com/dp/B000000001': 'USD', 'https://amazon.com/dp/B000000001': 'USD',
  'https://www.amazon.co.uk/dp/B000000001': 'GBP', 'https://www.amazon.com.au/dp/B000000001': 'AUD',
  'https://www.amazon.ca/dp/B000000001': 'CAD', 'https://www.amazon.de/dp/B000000001': 'EUR',
  'https://www.amazon.fr/dp/B000000001': 'EUR', 'https://www.amazon.in/dp/B000000001': 'INR',
  'https://www.amazon.co.jp/dp/B000000001': 'JPY', 'www.amazon.es': 'EUR',
};
for (const [url, currency] of Object.entries(cases)) assert.strictEqual(currencyForAmazonUrl(url), currency, url);
for (const bad of ['https://evilamazon.com/x', 'https://amazon.com.evil.io/x', 'https://example.com', '', null, undefined, 'nonsense']) assert.strictEqual(currencyForAmazonUrl(bad), null, String(bad));

// what a draft's price is in: the site first, then what was saved (a draft saved as USD from amazon.com.au is AUD)
assert.strictEqual(sourceCurrency('https://www.amazon.com.au/dp/B0AUS00001', 'USD'), 'AUD');
assert.strictEqual(sourceCurrency(null, 'gbp'), 'GBP');
assert.strictEqual(sourceCurrency('https://example.com', null), null);
assert.strictEqual(sourceCurrency(undefined, undefined), null);

// the extension's own guess (USD by default) does not override the site
const au = cleanProduct({ asin: 'B0AUS00001', title: 'Kettle', currency: 'USD', price: 49.95 }, 'https://www.amazon.com.au/dp/B0AUS00001');
assert.strictEqual(au.currency, 'AUD');
assert.strictEqual(cleanProduct({ asin: 'B0UKK00001', title: 'Kettle', currency: 'USD' }, 'https://www.amazon.co.uk/dp/B0UKK00001').currency, 'GBP');
assert.strictEqual(cleanProduct({ asin: 'B0USS00001', title: 'Kettle' }, 'https://www.amazon.com/dp/B0USS00001').currency, 'USD');
assert.strictEqual(cleanProduct({ asin: 'B0OTH00001', title: 'Kettle', currency: 'EUR' }, 'https://example.com/x').currency, 'EUR', 'an unknown site keeps what was sent');

// Easyparser / Canopy: the price's own currency wins; without one the site decides (not a blanket USD)
assert.strictEqual(normalizeDetail({ asin: 'B1', buybox_winner: { price: { value: 20, currency: 'AUD' } } }, 'https://www.amazon.com.au/dp/B1').currency, 'AUD');
assert.strictEqual(normalizeDetail({ asin: 'B1', buybox_winner: { price: { value: 20 } } }, 'https://www.amazon.com.au/dp/B1').currency, 'AUD');
assert.strictEqual(normalizeDetail({ asin: 'B1', link: 'https://amazon.co.uk/dp/B1' }).currency, 'GBP');
assert.strictEqual(normalizeProduct({ data: { amazonProduct: { asin: 'B2', price: { value: 20 } } } }, 'https://www.amazon.ca/dp/B2').currency, 'CAD');
assert.strictEqual(normalizeProduct({ data: { amazonProduct: { asin: 'B2', price: { value: 20, currency: 'GBP' } } } }, 'https://www.amazon.co.uk/dp/B2').currency, 'GBP');

// the extension decides the same way (its own copy of the table, cut out of content.js and run)
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8').split('\r\n').join('\n');
const a = src.indexOf('  const HOST_CURRENCY = {'); const b = src.indexOf('  const PRODUCT_INFORMATION_NAMES');
assert.ok(a > 0 && b > a);
const ctx = { String }; vm.createContext(ctx); vm.runInContext(src.slice(a, b) + '\nthis.f = currencyForHost;', ctx);
for (const [url, currency] of Object.entries(cases)) assert.strictEqual(ctx.f(new URL(/^https?:/.test(url) ? url : 'https://' + url).hostname), currency, 'extension: ' + url);
assert.strictEqual(ctx.f('www.example.com'), null);
// both tables list the same sites
const sameTable = /const HOST_CURRENCY = (\{[^}]*\});/.exec(src)[1];
const host = vm.runInNewContext('(' + sameTable + ')');
const { SUFFIX_CURRENCY } = require('../config/amazonDomains');
assert.deepStrictEqual(Object.assign({}, host), Object.assign({}, SUFFIX_CURRENCY), 'the extension and the server know the same Amazon sites');

console.log('amazon currency tests passed');
