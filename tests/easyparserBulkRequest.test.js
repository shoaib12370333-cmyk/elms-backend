// The Easyparser bulk request: a request that Easyparser refuses as a whole ("Bad request.") must never stop an import.
// The price currency is written the documented way first (GBP), then the other documented way (gbp), then left out - and the way that
// worked is remembered. Every kind of rejected item (invalid / failed / rate limit / no credit) comes back with its reason.
// The real submitBulkDetail runs here; only the HTTP call is scripted.
const assert = require('assert');

process.env.EASYPARSER_API_KEY = 'test-key';
const axios = require('axios');
const { submitBulkDetail, resetCurrencyMode } = require('../services/easyparserAmazonService');
console.warn = () => {}; // the service logs every refused request; not needed here

const calls = [];
let script = [];
axios.post = async (url, body) => {
  calls.push(JSON.parse(JSON.stringify(body)));
  const next = script.shift();
  if (!next) throw new Error('no scripted answer');
  if (next instanceof Error) throw next;
  return { data: next };
};
const httpError = (status, data) => Object.assign(new Error('Request failed with status code ' + status), { response: { status, data } });
const ok = (extra = {}) => ({ success: true, meta_data: {}, data: { accepted: [{ domain: '.co.uk', results: [{ asin: 'B0UKPRODUC', id: 'q-uk', credit: 1 }] }], ...extra } });
const UK = [{ domain: '.co.uk', asins: ['B0UKPRODUC'] }];
const reset = () => { calls.length = 0; script = []; resetCurrencyMode(); };
const currencyOf = (call, domain = '.co.uk') => call.find((j) => j.domain === domain).payload.currency;

(async () => {
  // ---------- 1. accepted the first time: capitals, and it stays that way ----------
  reset();
  script = [ok(), ok()];
  let r = await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(currencyOf(calls[0]), 'GBP');
  assert.deepStrictEqual(r.accepted, [{ asin: 'B0UKPRODUC', domain: '.co.uk', queryId: 'q-uk', credit: 1 }]);
  await submitBulkDetail(UK);
  assert.strictEqual(currencyOf(calls[1]), 'GBP');

  // ---------- 2. refused as a whole ("Bad request."): the small letters are tried, and remembered ----------
  reset();
  script = [httpError(400, { success: false, message: 'Bad request.' }), ok(), ok()];
  r = await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 2, 'one refused try, then the next way');
  assert.strictEqual(currencyOf(calls[0]), 'GBP');
  assert.strictEqual(currencyOf(calls[1]), 'gbp');
  assert.strictEqual(r.accepted.length, 1);
  await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 3, 'the next request goes straight to the way that worked');
  assert.strictEqual(currencyOf(calls[2]), 'gbp');

  // ---------- 3. neither way is taken: the request goes without a currency, and that is remembered ----------
  reset();
  script = [httpError(400, { success: false, message: 'Bad request.' }), httpError(400, { success: false, message: 'Bad request.' }), ok(), ok()];
  r = await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 3);
  assert.ok(!('currency' in calls[2][0].payload), 'no currency in the last try');
  assert.deepStrictEqual(calls[2][0].payload.asins, ['B0UKPRODUC']);
  assert.strictEqual(r.accepted.length, 1);
  await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 4);
  assert.ok(!('currency' in calls[3][0].payload));

  // ---------- 4. refused every time: the error says why, and nothing is remembered ----------
  reset();
  script = [httpError(400, { success: false, message: 'Bad request.' }), httpError(400, { success: false, message: 'Bad request.' }), httpError(400, { success: false, message: 'Bad request.' })];
  await assert.rejects(() => submitBulkDetail(UK), (e) => e.statusCode === 400 && e.message === 'Bad request.');
  assert.strictEqual(calls.length, 3);
  script = [ok()];
  await submitBulkDetail(UK);
  assert.strictEqual(currencyOf(calls[3]), 'GBP', 'a batch that failed for another reason did not switch the currency off');

  // ---------- 5. a 200 answer that says success:false is a refused request too ----------
  reset();
  script = [{ success: false, message: 'Bad request.' }, ok()];
  r = await submitBulkDetail(UK);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(currencyOf(calls[1]), 'gbp');
  assert.strictEqual(r.accepted.length, 1);

  // ---------- 6. an error that is not about the request itself is not retried with other currencies ----------
  reset();
  script = [httpError(401, { message: 'Invalid API key.' })];
  await assert.rejects(() => submitBulkDetail(UK), (e) => e.statusCode === 401 && /Invalid API key/.test(e.message));
  assert.strictEqual(calls.length, 1);

  // a site without a known currency carries none, so there is nothing to switch off
  reset();
  script = [httpError(400, { success: false, message: 'Bad request.' })];
  await assert.rejects(() => submitBulkDetail([{ domain: '.zz', asins: ['B0ZZPRODUC'] }]), (e) => e.statusCode === 400);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('currency' in calls[0][0].payload));

  // the other sites, written the way that is being tried
  reset();
  script = [{ success: true, data: { accepted: [] } }];
  await submitBulkDetail([{ domain: '.com', asins: ['A'] }, { domain: '.com.au', asins: ['B'] }, { domain: '.de', asins: ['C'] }, { domain: '.ca', asins: ['D'] }]);
  assert.deepStrictEqual(calls[0].map((j) => j.payload.currency), ['USD', 'AUD', 'EUR', 'CAD']);

  // ---------- 7. every kind of rejected item comes back with its reason ----------
  reset();
  script = [{
    success: true,
    meta_data: {},
    data: {
      accepted: [{ domain: '.com', results: [{ asin: 'B1', id: 'q1' }] }],
      invalid: [{ message: 'Invalid ASIN format at index 1: "XX"', instancePath: '/0/payload/asins/1', domain: '.com', path: 'body' }],
      failed: [{ id: 'f1', payload: { asin: 'B3' }, domain: '.com' }],
      rate_limit_exceeded: [{ message: '[!] Minute request limit exceeded.', payload: { domain: '.com', payload: { asin: 'B4' } } }],
      insufficient_credit: [{ message: '[!] You do not have enough credit to perform this action.', payload: { domain: '.com', payload: { asin: 'B5' } } }],
    },
  }];
  r = await submitBulkDetail([{ domain: '.com', asins: ['B1', 'B2', 'B3', 'B4', 'B5'] }]);
  const by = Object.fromEntries(r.rejected.map((x) => [x.asin, x]));
  assert.deepStrictEqual(r.accepted.map((a) => a.asin), ['B1']);
  assert.strictEqual(by.B2.reason, 'Invalid ASIN format at index 1: "XX"', 'the ASIN is found from the index in the request');
  assert.strictEqual(by.B2.retryable, false);
  assert.ok(/their side/.test(by.B3.reason) && by.B3.retryable === false, 'failed on their side');
  assert.ok(/limit exceeded/.test(by.B4.reason) && by.B4.retryable === true, 'rate limit: try again later');
  assert.ok(/credit/.test(by.B5.reason) && by.B5.retryable === true, 'no credit on the account: try again later');
  assert.strictEqual(r.rejected.length, 4);
  for (const x of r.rejected) assert.strictEqual(x.domain, '.com');

  // one invalid item says the currency is wrong: those items are tried again, the next way of writing it
  reset();
  script = [
    { success: true, data: { accepted: [], invalid: [{ message: 'Invalid currency value "GBP"', instancePath: '/0/payload/currency', domain: '.co.uk' }] } },
    ok(),
  ];
  r = await submitBulkDetail([{ domain: '.co.uk', asins: ['B0UKPRODUC', 'B0UKSECOND'] }]);
  assert.deepStrictEqual(r.rejected.map((x) => [x.asin, x.retryable]), [['B0UKPRODUC', true], ['B0UKSECOND', true]]);
  await submitBulkDetail(UK);
  assert.strictEqual(currencyOf(calls[1]), 'gbp', 'the next request uses the next way');

  console.log('easyparser bulk request tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
