// jobs/orderEarningsSync.js: splits one eBay order's fetched net earning across its ELMS line items proportionally to
// sale price, skips an account once a call fails with a missing-scope-shaped error instead of repeating it per order,
// and never touches an order whose earning is already set (setOrderEarningsBulk's filter: orderEarning === null).
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const accounts = [{ _id: 'acc1', userId: 'u1', ebayUserId: 'seller1', marketplaceId: 'EBAY_US' }];
stub('../models/schemas/EbayAccount', { find: async () => accounts });
stub('../models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => 'RT1' });
stub('../services/jobLockService', { acquireLock: async () => true });

let pendingByAccount = {};
const bulkCalls = [];
stub('../models/ordersModel', {
  listOrdersNeedingEarnings: async (accountId) => pendingByAccount[accountId] || [],
  setOrderEarningsBulk: async (updates) => { bulkCalls.push(updates); return updates.length; },
});

let nextTransactions = async () => [{ transactionType: 'SALE', amount: { value: '20.00', currency: 'USD' } }];
const financesCalls = [];
stub('../services/ebayFinancesService', {
  fetchSaleTransactionsForOrder: async (rt, orderId, marketplaceId) => { financesCalls.push({ rt, orderId, marketplaceId }); return nextTransactions(); },
  netEarningFromTransactions: (txns) => {
    const sales = (txns || []).filter((t) => t.transactionType === 'SALE');
    if (!sales.length) return null;
    return { amount: sales.reduce((s, t) => s + Number(t.amount.value), 0), currency: sales[0].amount.currency };
  },
});

const { runOrderEarningsSync, splitProportionally } = require('../jobs/orderEarningsSync');

(async () => {
  // ---------- splitProportionally: proportional to sale price, whole amount to a single line, never loses the figure with no usable price ----------
  assert.deepStrictEqual(splitProportionally(30, [{ _id: 'a', salePrice: 20 }, { _id: 'b', salePrice: 10 }]), [{ id: 'a', orderEarning: 20 }, { id: 'b', orderEarning: 10 }]);
  assert.deepStrictEqual(splitProportionally(15, [{ _id: 'a', salePrice: 15 }]), [{ id: 'a', orderEarning: 15 }]);
  assert.deepStrictEqual(splitProportionally(9, [{ _id: 'a', salePrice: null }, { _id: 'b', salePrice: 0 }]), [{ id: 'a', orderEarning: 9 }], 'no usable price on either line: goes to the first line rather than being dropped');

  // ---------- runOrderEarningsSync: fetches once per distinct eBay order, splits across that order's ELMS lines, saves ----------
  pendingByAccount = { acc1: [
    { _id: 'l1', ebayOrderId: 'O1', salePrice: 12 },
    { _id: 'l2', ebayOrderId: 'O1', salePrice: 8 }, // same eBay order as l1 - one fetch covers both
    { _id: 'l3', ebayOrderId: 'O2', salePrice: 5 },
  ] };
  nextTransactions = async () => [{ transactionType: 'SALE', amount: { value: '20.00', currency: 'USD' } }];
  bulkCalls.length = 0; financesCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(financesCalls.length, 2, 'one Finances call per distinct ebayOrderId, not per line');
  assert.deepStrictEqual(financesCalls.map((c) => c.orderId).sort(), ['O1', 'O2']);
  assert.strictEqual(financesCalls[0].marketplaceId, 'EBAY_US');
  const flat = bulkCalls.flat();
  assert.deepStrictEqual(flat.find((u) => u.id === 'l1').orderEarning, 12, 'O1\'s $20 split 12:8 by sale price');
  assert.deepStrictEqual(flat.find((u) => u.id === 'l2').orderEarning, 8);
  assert.deepStrictEqual(flat.find((u) => u.id === 'l3').orderEarning, 20, 'O2 is its own order, its own $20 fetch');

  // ---------- an order not yet settled on eBay's side (no SALE transaction back) is simply skipped, not an error ----------
  pendingByAccount = { acc1: [{ _id: 'l4', ebayOrderId: 'O3', salePrice: 9 }] };
  nextTransactions = async () => [];
  bulkCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(bulkCalls.flat().length, 0);

  // ---------- a missing-scope-shaped failure (401/403) stops the REST of this account's orders this run, without throwing ----------
  pendingByAccount = { acc1: [
    { _id: 'l5', ebayOrderId: 'O4', salePrice: 9 },
    { _id: 'l6', ebayOrderId: 'O5', salePrice: 9 },
  ] };
  let calls403 = 0;
  nextTransactions = async () => { calls403++; const e = new Error('Insufficient permissions to fulfill the request.'); e.statusCode = 403; throw e; };
  financesCalls.length = 0; bulkCalls.length = 0;
  await runOrderEarningsSync(); // must not throw
  assert.strictEqual(calls403, 1, 'the second order of the same account is never even tried once the first fails with 403');
  assert.strictEqual(bulkCalls.flat().length, 0);

  console.log('order earnings sync tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
