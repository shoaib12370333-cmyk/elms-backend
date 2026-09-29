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

const { ebayRequest, friendlyReasonFor } = require('../services/ebayListingService');

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

  console.log('eBay friendly error messages: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
