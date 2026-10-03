// eBay reuses one generic error (25019 "Cannot revise listing...") for very different real reasons, hidden as an
// unlabeled code inside `parameters` (e.g. "KYC_DSAReq_EUB2C_SYI" for a pending identity/DSA verification, or
// "SSR_BlockListing_ListingRevokedStatus" for a policy/VeRO block) - a seller has no way to know what those mean.
// friendlyReasonFor()/ebayRequest() recognize the ones actually seen in production and explain them in plain
// language instead, while anything unrecognized still falls back to the original describeEbayError() text.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async (rt) => 'AT-' + rt });

let responder = null; // (config) => never returns; throws an axios-shaped error instead
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async (config) => responder(config) };

const { ebayRequest, friendlyReasonFor, isAccountBlockedError } = require('../services/ebayListingService');

const ebayError = (errorId, message, parameterValues) => ({
  response: {
    status: 400,
    data: { errors: [{ errorId, message, parameters: parameterValues.map((value, i) => ({ name: String(i), value })) }] },
  },
});

(async () => {
  // ---------- KYC / EU DSA verification hold: a plain-language explanation, not the raw eBay reason code ----------
  responder = async () => { throw ebayError(25019, 'Cannot revise listing...', ['We still need to verify your details...', 'We still need to verify your details...', 'KYC_DSAReq_EUB2C_SYI', '1305595']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.match(err.message, /verify your identity or business details/i);
    assert.match(err.message, /Digital Services Act/i);
    assert.ok(!/KYC_DSAReq/.test(err.message), 'the internal eBay code itself should not leak into the friendly message');
    assert.strictEqual(err.statusCode, 400);
    assert.strictEqual(err.ebayErrors[0].errorId, 25019, 'the raw eBay error is still attached for logging/diagnostics');
    return true;
  });

  // ---------- policy/VeRO block: a different friendly message for a different reason code ----------
  responder = async () => { throw ebayError(25019, 'Cannot revise listing...', ['x', 'x', 'SSR_BlockListing_ListingRevokedStatus', '1291773']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.match(err.message, /blocked this listing/i);
    assert.match(err.message, /VeRO/i);
    return true;
  });

  // ---------- an unrecognized reason code: unchanged behaviour, the original describeEbayError() text ----------
  responder = async () => { throw ebayError(21916984, 'A category ID is invalid.', ['categoryId', '999999']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.match(err.message, /A category ID is invalid\. \(eBay error 21916984\)/);
    assert.match(err.message, /0: categoryId, 1: 999999/);
    return true;
  });

  // ---------- no eBay error body at all (network/timeout style failure): falls back to the raw error message ----------
  responder = async () => { throw new Error('socket hang up'); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), /socket hang up/);

  // ---------- friendlyReasonFor() directly: defends against odd shapes without throwing ----------
  assert.strictEqual(friendlyReasonFor(undefined), null);
  assert.strictEqual(friendlyReasonFor([]), null);
  assert.strictEqual(friendlyReasonFor([{ parameters: [] }]), null);
  assert.strictEqual(friendlyReasonFor([{ parameters: [{ name: '0', value: 'kyc_dsareq_something' }] }]), KNOWN(), 'match is case-insensitive');

  function KNOWN() { return friendlyReasonFor([{ parameters: [{ name: '0', value: 'KYC_DSAReq_EUB2C_SYI' }] }]); }

  // ---------- isAccountBlockedError(): tells "the whole account is blocked" apart from any other eBay error
  // (jobs/stockMonitor.js uses this to notify the seller once per run instead of once per listing/write) ----------
  responder = async () => { throw ebayError(25019, 'Cannot revise listing...', ['x', 'x', 'SSR_BlockListing_ListingRevokedStatus', '1291773']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.strictEqual(isAccountBlockedError(err), true);
    return true;
  });
  responder = async () => { throw ebayError(25019, 'Cannot revise listing...', ['We still need to verify your details...', 'We still need to verify your details...', 'KYC_DSAReq_EUB2C_SYI', '1305595']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.strictEqual(isAccountBlockedError(err), false, 'a different known reason code is not the account-block one');
    return true;
  });
  responder = async () => { throw ebayError(21916984, 'A category ID is invalid.', ['categoryId', '999999']); };
  await assert.rejects(() => ebayRequest('rt', 'GET', '/x'), (err) => {
    assert.strictEqual(isAccountBlockedError(err), false, 'an unrelated eBay error is not the account-block one');
    return true;
  });
  assert.strictEqual(isAccountBlockedError(undefined), false);
  assert.strictEqual(isAccountBlockedError(new Error('plain error, no ebayErrors at all')), false);
  assert.strictEqual(isAccountBlockedError({ ebayErrors: [] }), false);
  assert.strictEqual(isAccountBlockedError({ ebayErrors: [{ parameters: [] }] }), false);

  // ---------- a bulk call (bulk_update_price_quantity) refuses with { responses: [{ sku, statusCode, errors }] } and no top-level errors: the reason must not be lost ----------
  // (2026-10-03: the log only said "Request failed with status code 400" for two sold-out books)
  const bulkRefusal = (responses) => ({ response: { status: 400, data: { responses } } });
  responder = async () => { throw bulkRefusal([{ sku: 'B0X', statusCode: 400, errors: [{ errorId: 25709, message: 'Invalid value for weight.value.', parameters: [{ name: 'weight.value', value: '0' }] }] }]); };
  await assert.rejects(() => ebayRequest('rt', 'POST', '/x', {}), (err) => {
    assert.match(err.message, /Invalid value for weight\.value\. \(eBay error 25709\)/);
    assert.strictEqual(err.ebayErrors.length, 1); assert.strictEqual(err.ebayErrors[0].errorId, 25709);
    assert.strictEqual(err.statusCode, 400);
    return true;
  });
  // several entries: every error is kept; entries without errors add nothing
  responder = async () => { throw bulkRefusal([{ sku: 'A', statusCode: 200 }, { sku: 'B', statusCode: 400, errors: [{ errorId: 1, message: 'First.' }] }, { sku: 'C', statusCode: 400, errors: [{ errorId: 2, message: 'Second.' }] }]); };
  await assert.rejects(() => ebayRequest('rt', 'POST', '/x', {}), (err) => { assert.match(err.message, /First\. \(eBay error 1\); Second\. \(eBay error 2\)/); assert.strictEqual(err.ebayErrors.length, 2); return true; });
  // a normal top-level error list still wins over a responses list
  responder = async () => { throw { response: { status: 400, data: { errors: [{ errorId: 7, message: 'Top level.' }], responses: [{ sku: 'B', errors: [{ errorId: 8, message: 'Inner.' }] }] } } }; };
  await assert.rejects(() => ebayRequest('rt', 'POST', '/x', {}), (err) => { assert.match(err.message, /Top level\./); assert.ok(!/Inner/.test(err.message)); return true; });
  // nothing readable at all: the plain message, and the raw answer is kept for the log
  responder = async () => { throw { message: 'Request failed with status code 400', response: { status: 400, data: { responses: [{ sku: 'B', statusCode: 400 }] } } }; };
  await assert.rejects(() => ebayRequest('rt', 'POST', '/x', {}), (err) => {
    assert.strictEqual(err.message, 'Request failed with status code 400'); assert.strictEqual(err.ebayErrors, undefined);
    assert.deepStrictEqual(err.responseBody, { responses: [{ sku: 'B', statusCode: 400 }] });
    return true;
  });

  console.log('eBay friendly error messages: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
