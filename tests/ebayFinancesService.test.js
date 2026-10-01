// services/ebayFinancesService.js: the Finances API request shape (two separate filter= params, the required
// X-EBAY-C-MARKETPLACE-ID header, 204-No-Content handling), and the net-earning calculation from a SALE transaction.
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let nextResponse = () => ({ status: 200, data: {} });
const calls = [];
stub('axios', { get: (url, config) => { calls.push({ url, config }); return Promise.resolve(nextResponse()); } });
stub('../services/ebayAuthService', { getAccessToken: async (refreshToken) => 'AT-' + refreshToken });

const { fetchSaleTransactionsForOrder, netEarningFromTransactions } = require('../services/ebayFinancesService');

(async () => {
  // ---------- request shape: two separate filter= params (not one comma-joined string), the marketplace header, access token ----------
  nextResponse = () => ({ status: 200, data: { transactions: [{ transactionType: 'SALE', amount: { value: '18.50', currency: 'USD' } }] } });
  await fetchSaleTransactionsForOrder('RT1', '12-34567-89012', 'EBAY_GB');
  const { url, config } = calls[calls.length - 1];
  assert.ok(url.startsWith('https://apiz.ebay.com/sell/finances/v1/transaction?'), 'Finances is served from apiz, not api.ebay.com (confirmed 2026-09-29: api.ebay.com 404s on every real call)');
  assert.ok(url.includes('filter=orderId%3A%7B12-34567-89012%7D'), 'orderId filter, URL-encoded');
  assert.ok(url.includes('filter=transactionType%3A%7BSALE%7D'), 'transactionType filter, as its own separate filter= param');
  assert.strictEqual((url.match(/filter=/g) || []).length, 2, 'two separate filter= query params, never one comma-joined string');
  assert.strictEqual(config.headers.Authorization, 'Bearer AT-RT1');
  assert.strictEqual(config.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_GB');

  // a missing marketplaceId defaults to EBAY_US (the docs' own default), never an empty/missing header
  await fetchSaleTransactionsForOrder('RT1', '1', undefined);
  assert.strictEqual(calls[calls.length - 1].config.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');

  // ---------- 204 No Content (the docs: returned when nothing matches the filter) - empty array, never a throw ----------
  nextResponse = () => ({ status: 204, data: undefined });
  const empty = await fetchSaleTransactionsForOrder('RT1', '1', 'EBAY_US');
  assert.deepStrictEqual(empty, []);

  // ---------- an eBay error response is surfaced with its message ----------
  stub('axios', { get: () => Promise.reject({ response: { status: 403, data: { errors: [{ message: 'Insufficient permissions to fulfill the request.' }] } } }) });
  delete require.cache[require.resolve('../services/ebayFinancesService')];
  const svc2 = require('../services/ebayFinancesService');
  await assert.rejects(() => svc2.fetchSaleTransactionsForOrder('RT1', '1', 'EBAY_US'), (err) => {
    assert.strictEqual(err.statusCode, 403);
    assert.match(err.message, /Insufficient permissions/);
    return true;
  });

  // ---------- when a signing key is configured, the 3 digital-signature headers are merged in too (services/
  // ebayDigitalSignatureService.js), signed over the bare path - never the query string ----------
  delete require.cache[require.resolve('../services/ebayDigitalSignatureService')];
  stub('../services/ebayDigitalSignatureService', {
    signedHeaders: async ({ method, path, host }) => ({ 'x-ebay-signature-key': 'JWE', 'signature-input': `sig1=("x-ebay-signature-key" "@method" "@path" "@authority");created=1 (${method} ${path} ${host})`, signature: 'sig1=:abc:' }),
  });
  stub('axios', { get: (url, config) => { calls.push({ url, config }); return Promise.resolve({ status: 200, data: { transactions: [] } }); } });
  delete require.cache[require.resolve('../services/ebayFinancesService')];
  const svc3 = require('../services/ebayFinancesService');
  await svc3.fetchSaleTransactionsForOrder('RT1', '12-34567-89012', 'EBAY_GB');
  const last = calls[calls.length - 1];
  assert.strictEqual(last.config.headers['x-ebay-signature-key'], 'JWE');
  assert.strictEqual(last.config.headers.signature, 'sig1=:abc:');
  assert.ok(last.config.headers['signature-input'].includes('(GET /sell/finances/v1/transaction apiz.ebay.com)'), 'signed with the bare path - no query string - and the real host');

  // ---------- netEarningFromTransactions: sums SALE transactions, ignores anything else, null when there is nothing yet ----------
  assert.deepStrictEqual(netEarningFromTransactions([]), null);
  assert.deepStrictEqual(netEarningFromTransactions(null), null);
  assert.deepStrictEqual(
    netEarningFromTransactions([{ transactionType: 'SALE', amount: { value: '18.50', currency: 'USD' } }]),
    { amount: 18.5, currency: 'USD' }
  );
  // a REFUND row (or anything not SALE) mixed into the same order's transaction list is never counted in v1's earning
  assert.deepStrictEqual(
    netEarningFromTransactions([
      { transactionType: 'SALE', amount: { value: '10.00', currency: 'USD' } },
      { transactionType: 'REFUND', amount: { value: '-3.00', currency: 'USD' } },
    ]),
    { amount: 10, currency: 'USD' }
  );

  console.log('ebay finances service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
