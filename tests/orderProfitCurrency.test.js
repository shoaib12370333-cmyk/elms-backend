// Profit is worked out in the sale's currency: when the cost (the Amazon price) is in another currency it is converted first,
// and with no exchange rate the profit is left empty with a reason - never "GBP 20 - USD 15".
const assert = require('assert');
const Module = require('module');

const oid = (s) => ({ toString: () => s });
const doc = (f) => ({ _id: oid(f.id), userId: oid('u1'), salePrice: 20, quantity: 1, currency: 'GBP', ebayAccountId: null, listingId: null, ...f });
let orderDocs = [];
const chain = (result) => { const q = { populate: () => q, sort: () => q, select: () => q, lean: async () => result }; return q; };
let warmCalls = 0;
let rates = { USD: 1, GBP: 0.8, AUD: 1.5, EUR: 0.9 }; // per 1 USD
const fakes = {
  './schemas/Order': { find: () => chain(orderDocs), findOne: () => chain(orderDocs[0] || null), updateOne: async () => ({}), updateMany: async () => ({}) },
  './schemas/Listing': { find: () => chain([]), findOne: () => chain(null) },
  './schemas/Import': {},
  '../services/currencyService': {
    warmRates: async () => { warmCalls++; return true; },
    convertCached: (amount, from, to) => {
      if (String(from).toUpperCase() === String(to).toUpperCase()) return Number(amount);
      return rates && rates[from] && rates[to] ? Number((amount * (rates[to] / rates[from])).toFixed(2)) : null;
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /ordersModel/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { listOrders, getOrderById } = require('../models/ordersModel');
Module._load = origLoad;

(async () => {
  orderDocs = [
    doc({ id: 'same', listingId: { title: 'UK item', currency: 'GBP', amazonPrice: 8, importId: null } }),                         // GBP sale, GBP cost
    doc({ id: 'usd', listingId: { title: 'US item on a UK store', currency: 'USD', amazonPrice: 10, importId: null } }),           // USD cost, GBP sale
    doc({ id: 'aud', currency: 'AUD', salePrice: 60, quantity: 2, listingId: { title: 'AU', currency: 'GBP', amazonPrice: 10, importId: null } }),
    doc({ id: 'viaImport', listingId: { title: 'x', amazonPrice: null, importId: { currency: 'EUR', amazonPrice: 9 } } }),          // currency read from the import
    doc({ id: 'manual', currency: 'AUD', buyPriceOverride: 12, listingId: { title: 'y', currency: 'USD', amazonPrice: 5, importId: null } }), // the seller's own figure is already in the sale's currency
    doc({ id: 'mislabelled', currency: 'AUD', salePrice: 30, listingId: { title: 'AU item saved as USD', currency: 'USD', amazonPrice: 10, importId: { amazonUrl: 'https://www.amazon.com.au/dp/B0AUS00001', amazonPrice: 10 } } }), // the Amazon site says AUD
    doc({ id: 'unknown', listingId: { title: 'no currency saved', amazonPrice: 8, importId: null } }),                              // nothing to compare: as before
  ];
  let out = await listOrders('u1');
  const by = Object.fromEntries(out.map((o) => [o.id, o]));

  assert.strictEqual(by.same.buy_price, 8);
  assert.strictEqual(by.same.profit, 12);
  assert.strictEqual(by.same.buy_price_original, undefined, 'nothing converted');

  assert.strictEqual(by.usd.buy_price, 8, 'USD 10 = GBP 8');
  assert.strictEqual(by.usd.profit, 12, '20 - 8');
  assert.deepStrictEqual(by.usd.buy_price_original, { amount: 10, currency: 'USD' }, 'the original figure stays visible');
  assert.strictEqual(by.usd.buy_price_currency, 'GBP');

  assert.strictEqual(by.aud.buy_price, 18.75, 'GBP 10 = AUD 18.75');
  assert.strictEqual(by.aud.profit, 22.5, '60 - 18.75 x 2');

  assert.strictEqual(by.viaImport.buy_price, 8, 'EUR 9 = USD 10 = GBP 8');
  assert.strictEqual(by.manual.buy_price, 12, 'the seller\'s figure is not converted');
  assert.strictEqual(by.manual.profit, 8);
  assert.strictEqual(by.mislabelled.buy_price, 10, 'a cost saved as USD from amazon.com.au is AUD: no conversion');
  assert.strictEqual(by.mislabelled.profit, 20);
  assert.strictEqual(by.unknown.profit, 12, 'no currency on the listing: nothing to convert');
  assert.strictEqual(warmCalls, 1, 'the rates are loaded once for the whole list, not per order');

  // no exchange rate: no profit, and a reason - not a wrong number
  rates = null;
  orderDocs = [doc({ id: 'usd', listingId: { title: 'US item', currency: 'USD', amazonPrice: 10, importId: null } })];
  out = await listOrders('u1');
  assert.strictEqual(out[0].profit, null);
  assert.match(out[0].profit_note, /USD.*GBP.*no exchange rate/);
  assert.strictEqual(out[0].buy_price, 10, 'the cost is still shown as it is');

  // a list with nothing to convert never asks for rates
  warmCalls = 0;
  orderDocs = [doc({ id: 'a', listingId: { title: 'a', currency: 'GBP', amazonPrice: 8, importId: null } })];
  await listOrders('u1');
  assert.strictEqual(warmCalls, 0);

  // one order fetched after an action looks the same as in the list
  rates = { USD: 1, GBP: 0.8 };
  orderDocs = [doc({ id: 'usd', listingId: { title: 'US item', currency: 'USD', amazonPrice: 10, importId: null } })];
  const one = await getOrderById('u1', 'usd');
  assert.strictEqual(one.profit, 12);

  console.log('order profit currency tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
