// Large (background) import: the price of a product from amazon.co.uk stays in pounds from the Easyparser call to the draft, and the
// markup % is applied to it exactly. Before, Easyparser answered in its default currency (USD): 8.00 GBP came back as ~10.70 "USD",
// was saved as ~11.80 (with 10%), and was published to eBay as 11.80 GBP.
// The real submitBulkDetail and the real saveProductAsDraft / bulk-job route run here; only the services around them are stubs.
const assert = require('assert');
const Module = require('module');

process.env.EASYPARSER_API_KEY = 'test-key';

// ---------- stubs around routes/fetchProduct.js ----------
const drafts = [];
const charges = [];
const fxCalls = [];
let fxImpl = async (amount, from, to) => ({ amount: Number((amount * 0.75).toFixed(2)), rate: 0.75, converted: true });
const jobsCreated = [];
let credits = true;
let creditLimit = Infinity; // hasCredits says yes for any amount up to this
const creditChecks = [];
let activeStats = { jobs: 0, pendingItems: 0 };

const fakes = {
  '../models/importsModel': { createImport: async () => ({ id: 'imp1' }), updateImportImages: async () => {} },
  '../models/listingsModel': { findListingInStore: async () => null, upsertDraft: async (userId, draft) => { drafts.push(draft); return { id: 'd' + drafts.length }; } },
  '../models/usersModel': { getPricingRule: async () => null, hasCredits: async (userId, amount) => { creditChecks.push(amount); return credits && amount <= creditLimit; } },
  '../services/creditService': { withCredits: async (userId, cost, fn) => { charges.push(cost); return fn(); } },
  '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
  '../services/validationService': { isValidAmazonUrl: (u) => /^https?:\/\/(www\.)?amazon\./i.test(u), assertAmazonMatchesStore: () => {} },
  '../models/ebayAccountsModel': { getActiveEbayAccount: async () => ({ id: 'acc1', marketplaceId: 'EBAY_GB' }) },
  '../services/imageStorageService': { materializeImageUrls: async ({ urls }) => urls },
  '../services/skuService': { requireAsinSku: (asin) => asin },
  '../services/productCacheService': { getCachedProduct: async () => null, setCachedProduct: async () => {} },
  '../services/currencyService': { convertAmount: (...args) => { fxCalls.push(args); return fxImpl(...args); } },
  '../models/settingsModel': { getLimits: async () => ({ bulkImportMax: 25, bulkJobMax: 1000 }) },
  '../models/bulkImportJobsModel': { activeJobStats: async () => activeStats, createBulkImportJob: async (userId, job) => { jobsCreated.push(job); return { id: 'job1', total: job.items.length }; } },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes[\\/]fetchProduct\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/fetchProduct');
const { saveProductAsDraft, alignPriceCurrency, readMarkup } = router;

const UK = 'https://www.amazon.co.uk/dp/B0UKPRODUC';
const product = (over = {}) => ({ asin: 'B0UKPRODUC', title: 'Kettle', price: 10.72, currency: 'USD', images: ['https://m.media-amazon.com/images/I/A.jpg'], bulletPoints: [], specifications: [], ...over });
const reset = () => { drafts.length = 0; charges.length = 0; fxCalls.length = 0; fxImpl = async (amount) => ({ amount: Number((amount * 0.75).toFixed(2)), rate: 0.75, converted: true }); };

(async () => {
  // ---------- 1. the Easyparser bulk call asks for the price in the Amazon site's own currency ----------
  {
    const axios = require('axios');
    const origPost = axios.post;
    let body;
    axios.post = async (url, b) => { body = b; return { data: { data: { accepted: [] }, meta_data: {} } }; };
    const { submitBulkDetail } = require('../services/easyparserAmazonService');
    await submitBulkDetail([
      { domain: '.co.uk', asins: ['B0UKPRODUC'] }, { domain: '.com', asins: ['B0USPRODUC'] }, { domain: '.com.au', asins: ['B0AUPRODUC'] },
      { domain: '.de', asins: ['B0DEPRODUC'] }, { domain: '.ca', asins: ['B0CAPRODUC'] }, { domain: '.zz', asins: ['B0ZZPRODUC'] },
    ]);
    axios.post = origPost;
    const cur = (domain) => body.find((j) => j.domain === domain).payload;
    assert.strictEqual(cur('.co.uk').currency, 'GBP', 'a UK product is asked for in pounds');
    assert.strictEqual(cur('.com').currency, 'USD');
    assert.strictEqual(cur('.com.au').currency, 'AUD');
    assert.strictEqual(cur('.de').currency, 'EUR');
    assert.strictEqual(cur('.ca').currency, 'CAD');
    assert.deepStrictEqual(cur('.co.uk').asins, ['B0UKPRODUC'], 'the ASINs are still in the payload');
    assert.ok(!('currency' in cur('.zz')), 'a site we do not know is left to Easyparser');
    assert.ok(body.every((j) => !('currency' in j)), 'currency is a payload setting, not a root one');
  }

  // ---------- 2. a price that came back in another currency is put right before it is saved ----------
  reset();
  await saveProductAsDraft('u1', product(), 10, UK, {}, { id: 'acc1', marketplaceId: 'EBAY_GB' });
  assert.deepStrictEqual(fxCalls[0], [10.72, 'USD', 'GBP'], '10.72 USD is taken to GBP');
  assert.strictEqual(drafts[0].currency, 'GBP');
  assert.strictEqual(drafts[0].amazonPrice, 8.04, 'the cost is the pound price');
  assert.strictEqual(drafts[0].sellPrice, 8.84, '8.04 + 10%');
  assert.strictEqual(drafts[0].marginAmount, 0.8);
  assert.strictEqual(drafts[0].markupPercent, 10);

  // a price that already is in pounds: no conversion, the numbers are exactly what Amazon shows
  reset();
  await saveProductAsDraft('u1', product({ price: 8, currency: 'GBP' }), 10, UK, {}, null);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(drafts[0].currency, 'GBP');
  assert.strictEqual(drafts[0].amazonPrice, 8);
  assert.strictEqual(drafts[0].sellPrice, 8.8);
  assert.strictEqual(drafts[0].marginAmount, 0.8);

  // no currency at all: the site decides
  reset();
  await saveProductAsDraft('u1', product({ price: 8, currency: null }), 10, UK, {}, null);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(drafts[0].currency, 'GBP');

  // the same for the other stores that are looked at closely
  reset();
  await saveProductAsDraft('u1', product({ price: 20, currency: 'AUD' }), 20, 'https://www.amazon.com.au/dp/B0AUPRODUC', {}, null);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(drafts[0].currency, 'AUD');
  assert.strictEqual(drafts[0].sellPrice, 24);
  reset();
  await saveProductAsDraft('u1', product({ price: 20, currency: 'USD' }), 20, 'https://www.amazon.com/dp/B0USPRODUC', {}, null);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(drafts[0].currency, 'USD');

  // a site we do not know: the product is left as it is
  reset();
  await saveProductAsDraft('u1', product({ price: 20, currency: 'EUR' }), 10, 'https://example.com/x', {}, null);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(drafts[0].currency, 'EUR');

  // no exchange rate: nothing is saved and no credit is taken
  reset();
  fxImpl = async () => { throw new Error('rates down'); };
  await assert.rejects(() => saveProductAsDraft('u1', product(), 10, UK, {}, null), (e) => e.statusCode === 503 && /exchange rate/.test(e.message) && /USD/.test(e.message) && /GBP/.test(e.message));
  assert.strictEqual(charges.length, 0, 'no credit for a product that was not saved');
  assert.strictEqual(drafts.length, 0);

  // a product without a price is not converted
  reset();
  const noPrice = await alignPriceCurrency(product({ price: null, currency: 'USD' }), UK);
  assert.strictEqual(fxCalls.length, 0);
  assert.strictEqual(noPrice.currency, 'GBP');

  // ---------- 3. the markup % ----------
  const sell = async (price, markup) => { reset(); await saveProductAsDraft('u1', product({ price, currency: 'GBP' }), markup, UK, {}, null); return drafts[0]; };
  let d = await sell(8, 0);
  assert.strictEqual(d.sellPrice, 8, '0% = the Amazon price');
  assert.strictEqual(d.marginAmount, 0);
  d = await sell(8, 10); assert.strictEqual(d.sellPrice, 8.8);
  d = await sell(8, 12.5); assert.strictEqual(d.sellPrice, 9); assert.strictEqual(d.marginAmount, 1); assert.strictEqual(d.markupPercent, 12.5);
  d = await sell(8, 50); assert.strictEqual(d.sellPrice, 12);
  d = await sell(8, 100); assert.strictEqual(d.sellPrice, 16);
  d = await sell(8, -20); assert.strictEqual(d.sellPrice, 6.4); assert.strictEqual(d.marginAmount, -1.6);
  d = await sell(19.99, 30); assert.strictEqual(d.sellPrice, 25.99); assert.strictEqual(d.amazonPrice, 19.99);
  d = await sell(8, '10'); assert.strictEqual(d.sellPrice, 8.8, 'a number sent as text still works');
  reset();
  await saveProductAsDraft('u1', product({ price: null, currency: 'GBP' }), 10, UK, {}, null);
  assert.strictEqual(drafts[0].sellPrice, null, 'no Amazon price: no invented sell price');
  assert.strictEqual(drafts[0].marginAmount, null);

  // what the request may say
  assert.strictEqual(readMarkup(undefined), 0);
  assert.strictEqual(readMarkup(''), 0);
  assert.strictEqual(readMarkup(0), 0);
  assert.strictEqual(readMarkup(10), 10);
  assert.strictEqual(readMarkup('15.5'), 15.5);
  assert.strictEqual(readMarkup(-99), -99);
  assert.strictEqual(readMarkup(1000), 1000);
  for (const bad of [1001, -100, 'abc', NaN, Infinity, {}]) assert.strictEqual(readMarkup(bad), null, String(bad));

  // ---------- 4. the background-import route ----------
  const layer = router.stack.find((l) => l.route && l.route.path === '/bulk-job' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (body) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    await handler({ userId: 'u1', body }, res);
    return out;
  };
  let out = await call({ amazonUrls: [UK], markupPercent: 5000 });
  assert.strictEqual(out.status, 400); assert.ok(/between -99% and 1000%/.test(out.body.error));
  out = await call({ amazonUrls: [UK], markupPercent: 'abc' });
  assert.strictEqual(out.status, 400);
  assert.strictEqual(jobsCreated.length, 0, 'no job for a markup that makes no sense');
  out = await call({ amazonUrls: [UK, 'https://www.amazon.co.uk/dp/B0UKSECOND'], markupPercent: 12.5 });
  assert.strictEqual(out.body.success, true);
  assert.strictEqual(jobsCreated[0].markupPercent, 12.5);
  assert.strictEqual(jobsCreated[0].items.length, 2);
  assert.strictEqual(jobsCreated[0].items[0].country, 'GB');
  out = await call({ amazonUrls: [UK] }); // the field left out: 0%
  assert.strictEqual(jobsCreated[1].markupPercent, 0);
  out = await call({ amazonUrls: [UK], markupPercent: '' });
  assert.strictEqual(jobsCreated[2].markupPercent, 0);

  // ---------- 5. how many imports one person can run at once, and what their credits must cover ----------
  const created = jobsCreated.length;
  activeStats = { jobs: 3, pendingItems: 0 };
  out = await call({ amazonUrls: [UK] });
  assert.strictEqual(out.status, 429);
  assert.match(out.body.error, /already have 3 imports running/);
  assert.strictEqual(jobsCreated.length, created, 'no fourth import');
  activeStats = { jobs: 1, pendingItems: 40 }; creditChecks.length = 0;
  out = await call({ amazonUrls: [UK, 'https://www.amazon.co.uk/dp/B0UKSECOND'] });
  assert.strictEqual(out.body.success, true);
  assert.ok(creditChecks.includes(42), 'the credits must cover this list (2 products) AND what the other imports still have to save (40)');
  creditLimit = 41; // enough for this list alone, not for this list plus the 40 that are still waiting
  out = await call({ amazonUrls: [UK, 'https://www.amazon.co.uk/dp/B0UKSECOND'] });
  assert.strictEqual(out.status, 402);
  assert.match(out.body.error, /needs 42 credits in all \(40 more from your other imports are still waiting to be saved\)/);
  assert.strictEqual(jobsCreated.length, created + 1, 'only the list that was covered was started');
  activeStats = { jobs: 0, pendingItems: 0 }; creditLimit = Infinity;

  Module._load = origLoad;
  console.log('import currency tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
