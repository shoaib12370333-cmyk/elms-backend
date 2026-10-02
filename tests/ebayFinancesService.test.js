// services/ebayFinancesService.js: the Finances API request shape (two separate filter= params, the required
// X-EBAY-C-MARKETPLACE-ID header, 204-No-Content handling), and the net-earning calculation from a SALE transaction.
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let nextResponse = () => ({ status: 200, data: {} });
const calls = [];
stub('axios', { get: (url, config) => { calls.push({ url, config }); return Promise.resolve(nextResponse()); } });
stub('../services/ebayAuthService', { getAccessToken: async (refreshToken) => 'AT-' + refreshToken });

const { fetchSaleTransactionsForOrder, netEarningFromTransactions, adFeesFromTransactions } = require('../services/ebayFinancesService');

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

  // ---------- adFeesFromTransactions: only feeType AD_FEE (Promoted Listings), read from the SAME SALE transaction the earning
  // comes from - per eBay line item, exact in cents, never a made-up 0 when eBay did not say ----------
  const fee = (feeType, value, currency = 'GBP') => ({ feeType, amount: { value, currency } });
  const saleWith = (...orderLineItems) => ({ transactionType: 'SALE', amount: { value: '20.00', currency: 'GBP' }, orderLineItems });

  // a normal promoted sale: the final value fee is NOT an ad fee, only the AD_FEE entry counts
  assert.deepStrictEqual(
    adFeesFromTransactions([saleWith({ lineItemId: '111', marketplaceFees: [fee('FINAL_VALUE_FEE', '2.50'), fee('AD_FEE', '1.20'), fee('FINAL_VALUE_FEE_FIXED_PER_ORDER', '0.30')] })]),
    { total: 1.2, currency: 'GBP', byLineItem: { 111: 1.2 } }
  );
  // a sale that was not promoted: a REAL 0 (the line is in eBay's answer and has no ad fee), not null
  assert.deepStrictEqual(
    adFeesFromTransactions([saleWith({ lineItemId: '111', marketplaceFees: [fee('FINAL_VALUE_FEE', '2.50')] })]),
    { total: 0, currency: 'GBP', byLineItem: { 111: 0 } }
  );
  // two lines of one order each get their OWN fee; the total is exact (0.1 + 0.2 style sums stay exact)
  assert.deepStrictEqual(
    adFeesFromTransactions([saleWith(
      { lineItemId: 'A', marketplaceFees: [fee('AD_FEE', '0.10')] },
      { lineItemId: 'B', marketplaceFees: [fee('AD_FEE', '0.20')] },
      { lineItemId: 'C', marketplaceFees: [] },
    )]),
    { total: 0.3, currency: 'GBP', byLineItem: { A: 0.1, B: 0.2, C: 0 } }
  );
  // a credit (negative AD_FEE) is summed in as it is; several AD_FEE entries on one line add up
  assert.strictEqual(adFeesFromTransactions([saleWith({ lineItemId: 'A', marketplaceFees: [fee('AD_FEE', '1.00'), fee('AD_FEE', '-0.40')] })]).byLineItem.A, 0.6);
  // a REFUND (or any non-SALE) row is ignored, like the earning ignores it
  assert.deepStrictEqual(
    adFeesFromTransactions([saleWith({ lineItemId: 'A', marketplaceFees: [fee('AD_FEE', '1.00')] }), { transactionType: 'REFUND', orderLineItems: [{ lineItemId: 'A', marketplaceFees: [fee('AD_FEE', '-1.00')] }] }]),
    { total: 1, currency: 'GBP', byLineItem: { A: 1 } }
  );
  // nothing to read -> null (never 0): no transactions, no SALE, or a SALE that carries no orderLineItems at all
  assert.strictEqual(adFeesFromTransactions([]), null);
  assert.strictEqual(adFeesFromTransactions(null), null);
  assert.strictEqual(adFeesFromTransactions([{ transactionType: 'REFUND', orderLineItems: [] }]), null);
  assert.strictEqual(adFeesFromTransactions([{ transactionType: 'SALE', amount: { value: '20.00', currency: 'GBP' } }]), null, 'eBay did not list the fees: "no ad fee" cannot be told from "not said"');
  // a SALE that lists no fee at all (orderLineItems empty, or its items carry no marketplaceFees): unknown, NOT a made-up 0.00 -
  // a real sale always has at least its final value fee
  assert.strictEqual(adFeesFromTransactions([saleWith()]), null);
  assert.strictEqual(adFeesFromTransactions([saleWith({ lineItemId: 'A' }, { lineItemId: 'B', marketplaceFees: [] })]), null);
  // ...but once ANY line lists fees, a line with none of its own is a real 0
  assert.strictEqual(adFeesFromTransactions([saleWith({ lineItemId: 'A' }, { lineItemId: 'B', marketplaceFees: [fee('FINAL_VALUE_FEE', '1.00')] })]).byLineItem.A, 0);
  // malformed pieces never throw: a fee with no amount, a line item with no marketplaceFees, a null entry
  assert.deepStrictEqual(
    adFeesFromTransactions([saleWith({ lineItemId: 'A' }, null, { lineItemId: 'B', marketplaceFees: [{ feeType: 'AD_FEE' }, null, fee('AD_FEE', '0.50')] })]),
    { total: 0.5, currency: 'GBP', byLineItem: { A: 0, B: 0.5 } }
  );

  console.log('ebay finances service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
