// The stock / price monitor asks the Amazon site the product came from (a UK listing is checked on amazon.co.uk, an AU one on
// amazon.com.au) - asking amazon.com about a .co.uk ASIN looks like "out of stock" and would end a good listing.
// The repriced offer price is put in the store's currency, and no rate means no change (not a number in the wrong currency).
const assert = require('assert');
const Module = require('module');

const asked = [];
const priced = [];
const withdrawn = [];
let stock = { inStock: true, availabilityText: 'In Stock', price: 25, currency: 'GBP' };
let fx = { amount: 41.25 };
let fxFails = false;
let listings = [];
const updates = [];

const fakes = {
  '../services/canopyAmazonService': {
    checkAvailabilityByAsin: async (asin, country) => { asked.push([asin, country]); return stock; },
    detectCountryFromUrl: (url) => ({ 'www.amazon.co.uk': 'GB', 'www.amazon.com.au': 'AU', 'www.amazon.com': 'US', 'www.amazon.de': 'DE' })[new URL(url).hostname] || 'US',
  },
  '../services/ebayListingService': {
    withdrawListing: async (t, offer) => { withdrawn.push(offer); },
    updateOfferPrice: async (t, offer, price) => { priced.push([offer, price]); },
    updateOfferQuantity: async () => {},
  },
  '../models/listingsModel': {
    listPublishedListings: async () => listings,
    markEnded: async () => {},
    updateListing: async (u, id, fields) => { updates.push([id, fields]); },
  },
  '../models/importsModel': { updateImportPrice: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'token' },
  '../services/jobLockService': { acquireLock: async () => true },
  '../services/currencyService': { convertAmount: async (amount, from, to) => { if (fxFails) throw new Error('rates down'); return { amount: fx.amount, from, to }; } },
  '../models/usersModel': { spendCredit: async () => true, refundCredit: async () => {}, listUsersDueForStockCheck: async () => [], markStockCheckRan: async () => {} },
  'node-cron': { schedule: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /jobs.stockMonitor\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { runStockCheckForUser, supplierCountryOf } = require('../jobs/stockMonitor');
Module._load = origLoad;

const listing = (extra) => ({ id: 'l1', sku: 'B0TEST0001', asin: 'B0TEST0001', status: 'published', ebay_offer_id: 'o1', ebay_account_id: 'a1', quantity: 1, amazon_in_stock: true, sell_price: 30, amazon_price: 20, margin_amount: 10, currency: 'GBP', marketplace_id: 'EBAY_GB', amazon_url: 'https://www.amazon.co.uk/dp/B0TEST0001', repricing_enabled: true, ...extra });
const run = async (l) => { asked.length = 0; priced.length = 0; withdrawn.length = 0; updates.length = 0; listings = [l]; await runStockCheckForUser({ id: 'u1', email: 'u@x.com' }); };

(async () => {
  // which site is asked
  assert.strictEqual(supplierCountryOf({ amazon_url: 'https://www.amazon.co.uk/dp/X' }), 'GB');
  assert.strictEqual(supplierCountryOf({ amazon_url: 'https://www.amazon.com.au/dp/X' }), 'AU');
  assert.strictEqual(supplierCountryOf({ amazon_url: null, marketplace_id: 'EBAY_AU' }), 'AU', 'no link: the site that matches the store');
  assert.strictEqual(supplierCountryOf({ amazon_url: 'not a url', marketplace_id: 'EBAY_GB' }), 'GB');
  assert.strictEqual(supplierCountryOf({}), 'US', 'nothing known: the US, as before');

  await run(listing({}));
  assert.deepStrictEqual(asked, [['B0TEST0001', 'GB']], 'a UK listing is checked on the UK site');
  await run(listing({ marketplace_id: 'EBAY_AU', currency: 'AUD', amazon_url: 'https://www.amazon.com.au/dp/B0TEST0001' }));
  assert.deepStrictEqual(asked, [['B0TEST0001', 'AU']]);

  // out of stock on the RIGHT site ends the listing; the same product is not ended because of another site
  stock = { inStock: false, availabilityText: 'Currently unavailable' };
  await run(listing({}));
  assert.deepStrictEqual(withdrawn, ['o1'], 'genuinely out of stock: ended');
  stock = { inStock: true, availabilityText: 'In Stock', price: 25, currency: 'GBP' };

  // price moved 20 -> 25: same currency, so the offer gets the new price as it is (25 + the 10 margin = 35)
  await run(listing({}));
  assert.deepStrictEqual(priced, [['o1', 35]]);

  // a store with no Amazon site of its own (Ireland sells amazon.co.uk products, priced in GBP but sold in EUR): converted
  await run(listing({ marketplace_id: 'EBAY_IE', currency: 'GBP' }));
  assert.deepStrictEqual(priced, [['o1', 41.25]], 'the offer is in EUR: the new price is converted');
  assert.ok(updates.some(([, f]) => f.sellPrice === 35), 'the listing itself keeps its price in the draft\'s currency');

  // no exchange rate: the offer is left alone, and the baseline is not moved so the next check retries
  fxFails = true;
  await run(listing({ marketplace_id: 'EBAY_IE', currency: 'GBP' }));
  assert.deepStrictEqual(priced, []);
  assert.ok(!updates.some(([, f]) => f.amazonPrice === 25), 'baseline retained for the retry');

  console.log('stock monitor marketplace tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
