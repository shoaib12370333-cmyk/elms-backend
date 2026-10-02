// services/aliexpressAdapter.js quoteShipping (aliexpress.ds.freight.query): the request is the shape AliExpress's own API reference
// documents (one parameter, queryDeliveryReq, a JSON string), the answer is read from the documented sample shape, the cheapest
// usable option wins, a fee is never believed on a field name alone, and ANY problem is a null (never a throw, never a made-up 0)
// so a failed quote cannot break an import or a stock check. The real adapter runs; only AliExpress's network layer is a stand-in.
const assert = require('assert');

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const business = [];
let businessAnswer = async () => ({});
stub('../services/aliexpressAuthService', {
  callBusinessApi: async (method, accessToken, params) => { business.push({ method, accessToken, params }); return businessAnswer(); },
  refreshAccessToken: async () => { throw new Error('not expected'); },
});
const FAR = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const creds = new Map([['u1', { accessToken: 'AT1', refreshToken: 'RT1', accessTokenExpiresAt: FAR }]]);
stub('../models/usersModel', { getAliexpressCredentials: async (id) => creds.get(id) || null, setAliexpressTokens: async () => {} });

const adapter = require('../services/aliexpressAdapter');

// What AliExpress's own API reference shows for aliexpress.ds.freight.query (2026-10-03), after callBusinessApi unwrapped `result`.
const DOC_SAMPLE_OPTION = {
  code: 'CAINIAO_FULFILLMENT_STD', shipping_fee_currency: 'USD', free_shipping: 'false', mayHavePFS: 'false', guaranteed_delivery_days: '100',
  max_delivery_days: '40', tracking: 'true', shipping_fee_format: 'US $1.99', free_shipping_threshold: '$10.00', estimated_delivery_time: 'null',
  delivery_date_desc: 'null', company: 'AliExpress Selection Standard', ship_from_country: 'CN', min_delivery_days: '20', available_stock: '100',
  ddpIncludeVATTax: 'true', shipping_fee_cent: '1.99',
};
const answer = (options, extra) => ({ msg: 'Call succeeds', code: '200', success: 'true', delivery_options: options, ...extra });
const opt = (over) => ({ ...DOC_SAMPLE_OPTION, ...over });
const ASK = { productId: '3256802900954148', skuId: '12000023999200390', shipToCountry: 'GB', currency: 'USD' };

(async () => {
  // ---------- the request: exactly the documented shape ----------
  businessAnswer = async () => answer([DOC_SAMPLE_OPTION]);
  const quote = await adapter.quoteShipping('u1', ASK);
  assert.strictEqual(business.length, 1);
  assert.strictEqual(business[0].method, 'aliexpress.ds.freight.query');
  assert.strictEqual(business[0].accessToken, 'AT1');
  assert.deepStrictEqual(Object.keys(business[0].params), ['queryDeliveryReq'], 'one parameter, as documented');
  assert.strictEqual(typeof business[0].params.queryDeliveryReq, 'string', 'sent as a JSON string, like the docs\' sample');
  assert.deepStrictEqual(JSON.parse(business[0].params.queryDeliveryReq), { quantity: '1', shipToCountry: 'GB', productId: '3256802900954148', selectedSkuId: '12000023999200390', language: 'en_US', currency: 'USD' });

  // ---------- the documented sample answer ----------
  assert.deepStrictEqual(quote, {
    cost: 1.99, currency: 'USD', free: false, carrier: 'AliExpress Selection Standard', code: 'CAINIAO_FULFILLMENT_STD',
    minDays: 20, maxDays: 40, guaranteedDays: 100, shipFrom: 'CN', tracking: true, optionCount: 1,
  });

  // the answer wrapped one level deeper (result.result) is read too
  businessAnswer = async () => ({ result: answer([DOC_SAMPLE_OPTION]) });
  assert.strictEqual((await adapter.quoteShipping('u1', ASK)).cost, 1.99);

  // ---------- the cheapest option wins; of equal price the faster; free shipping is a real 0 ----------
  businessAnswer = async () => answer([
    opt({ code: 'SLOW', company: 'Slow', shipping_fee_cent: '3.50', shipping_fee_format: 'US $3.50', max_delivery_days: '60' }),
    opt({ code: 'CHEAP_SLOW', company: 'Cheap slow', shipping_fee_cent: '1.20', shipping_fee_format: 'US $1.20', max_delivery_days: '50' }),
    opt({ code: 'CHEAP_FAST', company: 'Cheap fast', shipping_fee_cent: '1.20', shipping_fee_format: 'US $1.20', max_delivery_days: '15', min_delivery_days: '8' }),
  ]);
  let q = await adapter.quoteShipping('u1', ASK);
  assert.deepStrictEqual([q.carrier, q.cost, q.maxDays, q.optionCount], ['Cheap fast', 1.2, 15, 3]);
  businessAnswer = async () => answer([opt({ code: 'PAID', shipping_fee_cent: '2.00', shipping_fee_format: 'US $2.00' }), opt({ code: 'FREE', company: 'Free one', free_shipping: 'true', shipping_fee_cent: '0.00', shipping_fee_format: 'US $0.00' })]);
  q = await adapter.quoteShipping('u1', ASK);
  assert.deepStrictEqual([q.carrier, q.cost, q.free], ['Free one', 0, true], 'free shipping is a real 0, not "unknown"');

  // ---------- a fee is never believed on its field name alone (it is called "cent" but the sample is in dollars) ----------
  const fee = adapter._shippingFeeOf;
  assert.strictEqual(fee({ shipping_fee_cent: '1.99', shipping_fee_format: 'US $1.99' }), 1.99, 'the documented case: both agree');
  assert.strictEqual(fee({ shipping_fee_cent: '199', shipping_fee_format: 'US $1.99' }), 1.99, 'if the number was really cents the price tag wins');
  assert.strictEqual(fee({ shipping_fee_cent: '7.00', shipping_fee_format: 'US $1.99' }), null, 'any other disagreement is not guessed at');
  assert.strictEqual(fee({ shipping_fee_format: 'US $2.50' }), 2.5, 'only a price tag: read from it');
  assert.strictEqual(fee({ shipping_fee_format: '1,99 EUR' }), 1.99, 'a decimal comma');
  assert.strictEqual(fee({ shipping_fee_format: '$1,299.50' }), 1299.5);
  assert.strictEqual(fee({ shipping_fee_cent: '4.25' }), 4.25, 'only the number: taken as dollars, like the sample');
  assert.strictEqual(fee({ shipping_fee_cent: '5000' }), null, 'a figure no one pays, with no price tag to check it against, is not believed');
  assert.strictEqual(fee({ shipping_fee_cent: '-3', shipping_fee_format: '' }), null, 'a negative fee is nonsense');
  assert.strictEqual(fee({}), null, 'nothing to read -> unknown, never 0');
  assert.strictEqual(fee({ shipping_fee_cent: '', shipping_fee_format: null }), null);
  for (const odd of [[], ' ', false, {}, '  ']) assert.strictEqual(fee({ shipping_fee_cent: odd }), null, 'Number(' + JSON.stringify(odd) + ') is 0 - not a free fee: ' + JSON.stringify(odd));
  assert.strictEqual(fee({ shipping_fee_cent: 0 }), 0, 'a real numeric 0 is a 0');
  assert.strictEqual(fee({ shipping_fee_cent: ' 2.5 ' }), 2.5);
  assert.strictEqual(fee({ free_shipping: true }), 0);

  // ---------- another currency than asked is never compared or stored ----------
  businessAnswer = async () => answer([opt({ shipping_fee_currency: 'EUR' })]);
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'a EUR fee for a USD listing is unusable');
  businessAnswer = async () => answer([opt({ shipping_fee_currency: 'EUR', code: 'EUR_ONE' }), opt({ code: 'USD_ONE', company: 'Dollar one', shipping_fee_cent: '2.00', shipping_fee_format: 'US $2.00' })]);
  assert.strictEqual((await adapter.quoteShipping('u1', ASK)).carrier, 'Dollar one', 'the usable option is still found');
  businessAnswer = async () => answer([opt({ shipping_fee_currency: undefined })]);
  assert.strictEqual((await adapter.quoteShipping('u1', ASK)).currency, 'USD', 'no currency stated: the requested one');

  // ---------- an option with no stock to send it with is not a quote (a missing stock figure is fine) ----------
  businessAnswer = async () => answer([opt({ code: 'NO_STOCK', company: 'No stock', shipping_fee_cent: '0.50', shipping_fee_format: 'US $0.50', available_stock: '0' }), opt({ code: 'OK', company: 'In stock', shipping_fee_cent: '2.00', shipping_fee_format: 'US $2.00', available_stock: '40' })]);
  assert.strictEqual((await adapter.quoteShipping('u1', ASK)).carrier, 'In stock', 'the cheaper option has no stock: skipped');
  businessAnswer = async () => answer([opt({ available_stock: undefined })]);
  assert.strictEqual((await adapter.quoteShipping('u1', ASK)).cost, 1.99, 'no stock figure given: still usable');

  // ---------- no usable quote -> null, never a throw, never 0 ----------
  businessAnswer = async () => answer([]);
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'no options');
  businessAnswer = async () => answer(undefined);
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'no option list at all');
  businessAnswer = async () => ({ msg: 'DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS', code: 'DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS', success: 'false' });
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'AliExpress cannot deliver there');
  businessAnswer = async () => answer([opt({ shipping_fee_cent: undefined, shipping_fee_format: undefined })]);
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'an option with no readable fee');
  businessAnswer = async () => { throw new Error('AliExpress said no.'); };
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'a failed call');
  businessAnswer = async () => null;
  assert.strictEqual(await adapter.quoteShipping('u1', ASK), null, 'an empty answer');
  businessAnswer = async () => answer([DOC_SAMPLE_OPTION]);
  assert.strictEqual(await adapter.quoteShipping('nobody', ASK), null, 'AliExpress not connected for this account: null, not a throw');

  // ---------- missing inputs: nothing is asked ----------
  business.length = 0;
  for (const bad of [{ ...ASK, productId: '' }, { ...ASK, skuId: null }, { ...ASK, shipToCountry: '' }, undefined]) assert.strictEqual(await adapter.quoteShipping('u1', bad), null);
  assert.strictEqual(business.length, 0, 'no AliExpress call without a product, a sku and a country');

  // ---------- quantity is a whole number of at least 1 ----------
  await adapter.quoteShipping('u1', { ...ASK, quantity: 3 });
  assert.strictEqual(JSON.parse(business[0].params.queryDeliveryReq).quantity, '3');
  business.length = 0;
  await adapter.quoteShipping('u1', { ...ASK, quantity: 0 });
  assert.strictEqual(JSON.parse(business[0].params.queryDeliveryReq).quantity, '1');

  console.log('aliexpress shipping quote tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
