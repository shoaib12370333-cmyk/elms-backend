// Research tools look at the Amazon site that matches the seller's store (the page sends only an ASIN), not always amazon.com.
const assert = require('assert');
const Module = require('module');

let account = null;
let accountFails = false;
const fakes = {
  '../models/ebayAccountsModel': { getActiveEbayAccount: async () => { if (accountFails) throw new Error('db down'); return account; } },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.researchTools\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { countryOf } = require('../routes/researchTools');
Module._load = origLoad;

const req = (query) => ({ userId: 'u1', query });

(async () => {
  account = { marketplaceId: 'EBAY_GB' };
  assert.strictEqual(await countryOf(req({ asin: 'B0TEST0001' })), 'GB', 'a UK store: amazon.co.uk');
  account = { marketplaceId: 'EBAY_AU' };
  assert.strictEqual(await countryOf(req({ asin: 'B0TEST0001' })), 'AU');
  account = { marketplaceId: 'EBAY_US' };
  assert.strictEqual(await countryOf(req({ asin: 'B0TEST0001' })), 'US');
  account = { marketplaceId: 'EBAY_GB' };
  assert.strictEqual(await countryOf(req({ country: 'au' })), 'AU', 'what was asked for wins');
  assert.strictEqual(await countryOf(req({ country: 'UK' })), 'GB');
  assert.strictEqual(await countryOf(req({ url: 'https://www.amazon.de/dp/B0TEST0001' })), 'DE', 'a pasted link names its own site');
  account = null;
  assert.strictEqual(await countryOf(req({ asin: 'B0TEST0001' })), 'US', 'no store connected: the US');
  accountFails = true;
  assert.strictEqual(await countryOf(req({ asin: 'B0TEST0001' })), 'US', 'a failed lookup never fails the tool');
  console.log('research country tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
