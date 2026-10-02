// jobs/orderEarningsSync.js: splits one eBay order's fetched net earning across its ELMS line items proportionally to
// sale price, skips an account once a call fails with a missing-scope-shaped error instead of repeating it per order,
// and never touches an order whose earning is already set (setOrderEarningsBulk's filter: orderEarning === null).
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const accounts = [{ _id: 'acc1', userId: 'u1', ebayUserId: 'seller1', marketplaceId: 'EBAY_US', financesSyncError: null }];
const updateOneCalls = [];
stub('../models/schemas/EbayAccount', {
  find: async () => accounts,
  updateOne: async (filter, update) => {
    updateOneCalls.push({ filter, update });
    const acc = accounts.find((a) => a._id === filter._id);
    if (acc && update.$set && 'financesSyncError' in update.$set) acc.financesSyncError = update.$set.financesSyncError;
    return { acknowledged: true };
  },
});
stub('../models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => 'RT1' });
stub('../services/jobLockService', { acquireLock: async () => true });

let pendingByAccount = {};
let backfillByAccount = {}; // lines that already have an earning but never had their ad fee read
const bulkCalls = [];
const adFeeBulkCalls = [];
const checkedCalls = [];
const backfillQueries = [];
let adFeeSaveFails = false;
stub('../models/ordersModel', {
  listOrdersNeedingEarnings: async (accountId) => pendingByAccount[accountId] || [],
  setOrderEarningsBulk: async (updates) => { bulkCalls.push(updates); return updates.length; },
  listOrdersNeedingAdFee: async (userId, accountId, limit, minAgeMs) => { backfillQueries.push({ userId, accountId, limit, minAgeMs }); return backfillByAccount[accountId] || []; },
  setOrderAdFeesBulk: async (updates) => { if (adFeeSaveFails) throw new Error('mongo down'); adFeeBulkCalls.push(updates); return updates.length; },
  markAdFeeChecked: async (ids) => { checkedCalls.push(ids); return ids.length; },
});

let nextTransactions = async () => [{ transactionType: 'SALE', amount: { value: '20.00', currency: 'USD' } }];
let nextAdFees = () => null; // the ad fees eBay's answer holds, in adFeesFromTransactions' shape (null = nothing to read)
const financesCalls = [];
stub('../services/ebayFinancesService', {
  fetchSaleTransactionsForOrder: async (rt, orderId, marketplaceId) => { financesCalls.push({ rt, orderId, marketplaceId }); return nextTransactions(); },
  netEarningFromTransactions: (txns) => {
    const sales = (txns || []).filter((t) => t.transactionType === 'SALE');
    if (!sales.length) return null;
    return { amount: sales.reduce((s, t) => s + Number(t.amount.value), 0), currency: sales[0].amount.currency };
  },
  adFeesFromTransactions: (txns) => nextAdFees(txns),
});

const { runOrderEarningsSync, splitProportionally, adFeeShares, AD_FEE_BACKFILL_PER_RUN, AD_FEE_BACKFILL_MIN_AGE_MS } = require('../jobs/orderEarningsSync');

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
  financesCalls.length = 0; bulkCalls.length = 0; updateOneCalls.length = 0;
  await runOrderEarningsSync(); // must not throw
  assert.strictEqual(calls403, 1, 'the second order of the same account is never even tried once the first fails with 403');
  assert.strictEqual(bulkCalls.flat().length, 0);

  // ---------- that failure is also saved on the account itself, so Settings can show a reason instead of staying silent ----------
  assert.strictEqual(updateOneCalls.length, 1);
  assert.deepStrictEqual(updateOneCalls[0].filter, { _id: 'acc1' });
  assert.strictEqual(updateOneCalls[0].update.$set.financesSyncError, 'Insufficient permissions to fulfill the request.');
  assert.strictEqual(accounts[0].financesSyncError, 'Insufficient permissions to fulfill the request.');

  // ---------- once the account reconnects and a run succeeds again, the stuck flag is cleared back to null ----------
  pendingByAccount = { acc1: [{ _id: 'l11', ebayOrderId: 'O10', salePrice: 9 }] };
  nextTransactions = async () => [{ transactionType: 'SALE', amount: { value: '9.00', currency: 'USD' } }];
  updateOneCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(updateOneCalls.length, 1);
  assert.strictEqual(updateOneCalls[0].update.$set.financesSyncError, null);
  assert.strictEqual(accounts[0].financesSyncError, null);

  // ---------- the same short-circuit for a real eBay "invalid_scope"-worded error whose statusCode is NOT 401/403 ----------
  pendingByAccount = { acc1: [
    { _id: 'l7', ebayOrderId: 'O6', salePrice: 9 },
    { _id: 'l8', ebayOrderId: 'O7', salePrice: 9 },
  ] };
  let callsScopeMsg = 0;
  nextTransactions = async () => { callsScopeMsg++; const e = new Error('The requested scope is invalid, unknown, malformed, or exceeds the scope granted to the client'); e.statusCode = 400; throw e; };
  financesCalls.length = 0; bulkCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(callsScopeMsg, 1, 'the message alone (statusCode 400 here, not 401/403) is enough to stop trying the rest of this account');
  assert.strictEqual(bulkCalls.flat().length, 0);

  // ---------- the exact production wording for a dead/revoked refresh token (eBay's OAuth invalid_grant, HTTP 400 -
  // NOT 401/403) also short-circuits the rest of this account's orders, instead of hammering eBay's token endpoint
  // once per pending order, every run, forever (the bug this exact case was missing before) ----------
  pendingByAccount = { acc1: [
    { _id: 'l9', ebayOrderId: 'O8', salePrice: 9 },
    { _id: 'l10', ebayOrderId: 'O9', salePrice: 9 },
  ] };
  let callsInvalidToken = 0;
  nextTransactions = async () => { callsInvalidToken++; const e = new Error('the provided authorization refresh token is invalid or was issued to another client'); e.statusCode = 400; throw e; };
  financesCalls.length = 0; bulkCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(callsInvalidToken, 1, 'a dead refresh token also stops the rest of this account\'s orders on the first failure');
  assert.strictEqual(bulkCalls.flat().length, 0);

  // ---------- a plain, non-scope-shaped error (not 401/403, no scope/token wording) that fails EVERY pending order
  // this run is also surfaced - not just the missing-scope case - since from the seller's side both look identical:
  // the column simply never fills in, forever, with nothing to see but a server log line ----------
  pendingByAccount = { acc1: [
    { _id: 'l12', ebayOrderId: 'O11', salePrice: 9 },
    { _id: 'l13', ebayOrderId: 'O12', salePrice: 9 },
  ] };
  nextTransactions = async () => { const e = new Error('Invalid marketplace id.'); e.statusCode = 400; throw e; };
  updateOneCalls.length = 0; bulkCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(updateOneCalls.length, 1);
  assert.strictEqual(updateOneCalls[0].update.$set.financesSyncError, 'Invalid marketplace id.');
  assert.strictEqual(accounts[0].financesSyncError, 'Invalid marketplace id.');

  // ---------- a PARTIAL failure (one order errors, another still comes back fine) is left alone - not every order
  // failed, so this is treated as normal rather than flagged as a stuck account ----------
  let partialCall = 0;
  pendingByAccount = { acc1: [
    { _id: 'l14', ebayOrderId: 'O13', salePrice: 9 },
    { _id: 'l15', ebayOrderId: 'O14', salePrice: 9 },
  ] };
  nextTransactions = async () => {
    partialCall++;
    if (partialCall === 1) { const e = new Error('Temporary eBay hiccup'); e.statusCode = 500; throw e; }
    return [{ transactionType: 'SALE', amount: { value: '9.00', currency: 'GBP' } }];
  };
  updateOneCalls.length = 0; bulkCalls.length = 0;
  await runOrderEarningsSync();
  assert.strictEqual(bulkCalls.flat().length, 1, 'the order that did come back fine is still saved');
  assert.strictEqual(updateOneCalls.length, 0, 'one order out of two failing is not enough to flag the whole account');
  assert.strictEqual(accounts[0].financesSyncError, 'Invalid marketplace id.', 'the stale flag from the fully-failed run above is left as is, since this run did not fully succeed either');

  // =====================================================================================================================
  // Ad fee (Promoted Listings, feeType AD_FEE): read from the SAME Finances call as the earning - no extra eBay call
  // for a new order - and, once, for the orders that already had an earning before the Ad fee column existed.
  // =====================================================================================================================
  const reset = () => { financesCalls.length = 0; bulkCalls.length = 0; adFeeBulkCalls.length = 0; checkedCalls.length = 0; backfillQueries.length = 0; updateOneCalls.length = 0; adFeeSaveFails = false; pendingByAccount = {}; backfillByAccount = {}; nextAdFees = () => null; nextTransactions = async () => [{ transactionType: 'SALE', amount: { value: '20.00', currency: 'USD' } }]; };

  // ---------- adFeeShares: each line gets ITS OWN fee when eBay lists every line; never a guess when it is unclear which fee is whose ----------
  const twoLines = [{ _id: 'a', ebayLineItemId: 'LI1', salePrice: 12 }, { _id: 'b', ebayLineItemId: 'LI2', salePrice: 8 }];
  assert.deepStrictEqual(adFeeShares({ total: 2, byLineItem: { LI1: 0.5, LI2: 1.5 } }, twoLines), [{ id: 'a', adFee: 0.5 }, { id: 'b', adFee: 1.5 }], 'exact per line - a split by price would have said 1.2 / 0.8');
  assert.deepStrictEqual(adFeeShares({ total: 2, byLineItem: { LI1: 2, LI2: 0 } }, twoLines), [{ id: 'a', adFee: 2 }, { id: 'b', adFee: 0 }], 'a line eBay says had none gets a real 0');
  assert.deepStrictEqual(adFeeShares({ total: 2, byLineItem: {} }, twoLines), [], 'lines eBay did not list: no telling whose fee is whose, so nothing - never a split by price (it would double-count when the lines are handled in different runs)');
  assert.deepStrictEqual(adFeeShares({ total: 2, byLineItem: { LI1: 2 } }, twoLines), [], 'one of two lines unmatched: nothing for either, never a half-guess');
  assert.deepStrictEqual(adFeeShares({ total: 3, byLineItem: { X: 3 } }, [{ _id: 'a', salePrice: 5 }]), [{ id: 'a', adFee: 3 }], 'a single-line order: its one line gets the fee even when ELMS never stored the line id');
  assert.deepStrictEqual(adFeeShares({ total: 5, byLineItem: { X: 3, Y: 2 } }, [{ _id: 'a', salePrice: 5 }]), [], 'eBay says TWO lines but only one ELMS line is up for this: which fee is it? nothing');
  assert.deepStrictEqual(adFeeShares({ total: 5, byLineItem: { LI1: 3, LI2: 2 } }, [twoLines[1]]), [{ id: 'b', adFee: 2 }], 'a single line of a bigger order, matched by its id (the other line was handled in an earlier run): exact, nothing double-counted');

  // ---------- a NEW order: its ad fee is saved together with its earning, from ONE Finances call ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n1', ebayOrderId: 'N1', ebayLineItemId: 'LI1', salePrice: 20 }] };
  nextAdFees = () => ({ total: 2.4, currency: 'USD', byLineItem: { LI1: 2.4 } });
  await runOrderEarningsSync();
  assert.strictEqual(financesCalls.length, 1, 'the ad fee costs no extra eBay call');
  assert.deepStrictEqual(bulkCalls.flat(), [{ id: 'n1', orderEarning: 20 }]);
  assert.deepStrictEqual(adFeeBulkCalls.flat(), [{ id: 'n1', adFee: 2.4 }]);

  // ---------- a promoted-less new order: a real 0, saved ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n2', ebayOrderId: 'N2', ebayLineItemId: 'LI9', salePrice: 20 }] };
  nextAdFees = () => ({ total: 0, currency: 'USD', byLineItem: { LI9: 0 } });
  await runOrderEarningsSync();
  assert.deepStrictEqual(adFeeBulkCalls.flat(), [{ id: 'n2', adFee: 0 }]);

  // ---------- a new order whose answer has no fee list (adFees null): earning saved, NO made-up ad fee ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n3', ebayOrderId: 'N3', ebayLineItemId: 'LI3', salePrice: 20 }] };
  await runOrderEarningsSync();
  assert.strictEqual(bulkCalls.flat().length, 1);
  assert.strictEqual(adFeeBulkCalls.flat().length, 0, 'unknown stays empty, never 0');

  // ---------- the BACKFILL: an order that already had its earning gets only its ad fee (the earning is never touched) ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'b1', ebayOrderId: 'B1', ebayLineItemId: 'LIB', salePrice: 20 }] };
  nextAdFees = () => ({ total: 1.5, currency: 'USD', byLineItem: { LIB: 1.5 } });
  await runOrderEarningsSync();
  assert.deepStrictEqual(backfillQueries, [{ userId: 'u1', accountId: 'acc1', limit: AD_FEE_BACKFILL_PER_RUN, minAgeMs: AD_FEE_BACKFILL_MIN_AGE_MS }], 'asked for a bounded number of old lines per account per run');
  assert.ok(AD_FEE_BACKFILL_MIN_AGE_MS >= 24 * 60 * 60 * 1000, 'only orders paid long enough ago for eBay to have settled them - a "nothing there" answer is stamped as final');
  assert.ok(AD_FEE_BACKFILL_PER_RUN > 0 && AD_FEE_BACKFILL_PER_RUN <= 50, 'a small, bounded backlog step - one Finances call per order');
  assert.strictEqual(financesCalls.length, 1);
  assert.deepStrictEqual(adFeeBulkCalls.flat(), [{ id: 'b1', adFee: 1.5 }]);
  assert.strictEqual(bulkCalls.flat().length, 0, 'the earning that is already there is not rewritten');

  // ---------- an order with BOTH a line still waiting for its earning and a line waiting for its ad fee: one call covers both ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'p1', ebayOrderId: 'M1', ebayLineItemId: 'LI1', salePrice: 12 }] };
  backfillByAccount = { acc1: [{ _id: 'p2', ebayOrderId: 'M1', ebayLineItemId: 'LI2', salePrice: 8 }] };
  nextAdFees = () => ({ total: 2, currency: 'USD', byLineItem: { LI1: 0.5, LI2: 1.5 } });
  await runOrderEarningsSync();
  assert.strictEqual(financesCalls.length, 1, 'same eBay order, one call');
  assert.deepStrictEqual(adFeeBulkCalls.flat(), [{ id: 'p1', adFee: 0.5 }, { id: 'p2', adFee: 1.5 }]);
  assert.deepStrictEqual(bulkCalls.flat().map((u) => u.id), ['p1'], 'only the line that lacked an earning gets one');

  // ---------- eBay has NO transaction for an order that already had its earning: stamped, so it is not asked about forever ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'b2', ebayOrderId: 'B2', ebayLineItemId: 'LIB2', salePrice: 20 }] };
  nextTransactions = async () => [];
  await runOrderEarningsSync();
  assert.deepStrictEqual(checkedCalls, [['b2']]);
  assert.strictEqual(adFeeBulkCalls.flat().length, 0);

  // ---------- a transaction with no fee list: nothing to read -> stamped too (otherwise the newest ones would be retried first, every run, forever) ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'b3', ebayOrderId: 'B3', ebayLineItemId: 'LIB3', salePrice: 20 }] };
  nextAdFees = () => null;
  await runOrderEarningsSync();
  assert.deepStrictEqual(checkedCalls, [['b3']]);

  // ---------- a backfill line nobody can tell the fee of (multi-line order, line ids do not match) is stamped, so it is not retried forever and cannot double-count ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'm1', ebayOrderId: 'MM1', ebayLineItemId: 'GONE', salePrice: 5 }] };
  nextAdFees = () => ({ total: 5, currency: 'USD', byLineItem: { LI1: 3, LI2: 2 } });
  await runOrderEarningsSync();
  assert.strictEqual(adFeeBulkCalls.flat().length, 0, 'no guess saved');
  assert.deepStrictEqual(checkedCalls, [['m1']]);

  // ---------- a NEW order whose fee list cannot be read is NOT stamped (it just got its earning; the backfill looks again after 3 days) ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n6', ebayOrderId: 'N6', ebayLineItemId: 'LI6', salePrice: 20 }] };
  nextAdFees = () => null;
  await runOrderEarningsSync();
  assert.strictEqual(bulkCalls.flat().length, 1);
  assert.strictEqual(checkedCalls.length, 0);

  // ---------- a NEW order that is not settled yet (no SALE transaction) is NOT stamped - it simply waits for its first chance ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n4', ebayOrderId: 'N4', ebayLineItemId: 'LI4', salePrice: 20 }] };
  nextTransactions = async () => [];
  await runOrderEarningsSync();
  assert.strictEqual(checkedCalls.length, 0);

  // ---------- a failing eBay call is NOT stamped (it is retried next run), and stops the account on a scope-shaped error ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'b4', ebayOrderId: 'B4', ebayLineItemId: 'L4', salePrice: 5 }, { _id: 'b5', ebayOrderId: 'B5', ebayLineItemId: 'L5', salePrice: 5 }] };
  nextTransactions = async () => { const e = new Error('Insufficient permissions to fulfill the request.'); e.statusCode = 403; throw e; };
  await runOrderEarningsSync();
  assert.strictEqual(financesCalls.length, 1, 'the second backfill order is not even tried after a 403');
  assert.strictEqual(checkedCalls.length, 0, 'an error says nothing about the order, so it stays pending');

  // ---------- a backfill order eBay keeps refusing for its OWN reason (4xx) is stamped when other orders of the account came back
  // fine - otherwise it stays among the newest lines forever and starves the older backlog behind it ----------
  reset();
  backfillByAccount = { acc1: [
    { _id: 'f1', ebayOrderId: 'F1', ebayLineItemId: 'LIF1', salePrice: 5 },
    { _id: 'f2', ebayOrderId: 'F2', ebayLineItemId: 'LIF2', salePrice: 5 },
    { _id: 'f3', ebayOrderId: 'F3', ebayLineItemId: 'LIF3', salePrice: 5 },
  ] };
  nextTransactions = async () => {
    const orderId = financesCalls[financesCalls.length - 1].orderId;
    if (orderId === 'F1') { const e = new Error('Invalid filter value.'); e.statusCode = 400; throw e; }
    if (orderId === 'F2') { const e = new Error('eBay is having a moment'); e.statusCode = 503; throw e; }
    return [{ transactionType: 'SALE', amount: { value: '9.00', currency: 'USD' } }];
  };
  nextAdFees = () => ({ total: 0, currency: 'USD', byLineItem: { LIF3: 0 } });
  await runOrderEarningsSync();
  assert.deepStrictEqual(adFeeBulkCalls.flat(), [{ id: 'f3', adFee: 0 }]);
  assert.deepStrictEqual(checkedCalls.flat(), ['f1'], 'the 400 is that order\'s own problem -> stamped; the 503 is transient -> stays pending');

  // ---------- ...but when NOTHING came back fine this run, a 4xx is account-wide (e.g. a wrong marketplace) and stamps nothing ----------
  reset();
  backfillByAccount = { acc1: [{ _id: 'g1', ebayOrderId: 'G1', ebayLineItemId: 'LIG1', salePrice: 5 }, { _id: 'g2', ebayOrderId: 'G2', ebayLineItemId: 'LIG2', salePrice: 5 }] };
  nextTransactions = async () => { const e = new Error('Invalid marketplace id.'); e.statusCode = 400; throw e; };
  await runOrderEarningsSync();
  assert.strictEqual(checkedCalls.length, 0, 'fixing the account must not find its whole backlog already given up on');

  // ---------- backfill errors never raise (or keep) the "earnings are stuck" warning on the account - only orders waiting for their EARNING do ----------
  reset();
  accounts[0].financesSyncError = null;
  backfillByAccount = { acc1: [{ _id: 'h1', ebayOrderId: 'H1', ebayLineItemId: 'LIH1', salePrice: 5 }] };
  nextTransactions = async () => { const e = new Error('Invalid filter value.'); e.statusCode = 400; throw e; };
  await runOrderEarningsSync();
  assert.strictEqual(updateOneCalls.length, 0, 'an old order failing its ad-fee backfill, with nothing pending, does not flag the account');
  assert.strictEqual(accounts[0].financesSyncError, null);

  reset();
  accounts[0].financesSyncError = 'Insufficient permissions to fulfill the request.'; // a stale warning from before the seller reconnected
  pendingByAccount = { acc1: [{ _id: 'h2', ebayOrderId: 'H2', ebayLineItemId: 'LIH2', salePrice: 5 }] };
  backfillByAccount = { acc1: [{ _id: 'h3', ebayOrderId: 'H3', ebayLineItemId: 'LIH3', salePrice: 5 }] };
  nextTransactions = async () => {
    if (financesCalls[financesCalls.length - 1].orderId === 'H3') { const e = new Error('Invalid filter value.'); e.statusCode = 400; throw e; }
    return [{ transactionType: 'SALE', amount: { value: '9.00', currency: 'USD' } }];
  };
  await runOrderEarningsSync();
  assert.strictEqual(bulkCalls.flat().length, 1, 'the new order\'s earning was saved');
  assert.strictEqual(accounts[0].financesSyncError, null, 'one persistently failing OLD order no longer keeps the stale warning from clearing once earnings work again');

  // ---------- a backfill-only run that comes back fine also clears a stale warning (the account demonstrably works) ----------
  reset();
  accounts[0].financesSyncError = 'Insufficient permissions to fulfill the request.';
  backfillByAccount = { acc1: [{ _id: 'h4', ebayOrderId: 'H4', ebayLineItemId: 'LIH4', salePrice: 5 }] };
  nextAdFees = () => ({ total: 0, currency: 'USD', byLineItem: { LIH4: 0 } });
  await runOrderEarningsSync();
  assert.strictEqual(accounts[0].financesSyncError, null);

  // ---------- a problem saving the ad fees never stops the earnings from being saved ----------
  reset();
  pendingByAccount = { acc1: [{ _id: 'n5', ebayOrderId: 'N5', ebayLineItemId: 'LI5', salePrice: 20 }] };
  nextAdFees = () => ({ total: 1, currency: 'USD', byLineItem: { LI5: 1 } });
  adFeeSaveFails = true;
  await runOrderEarningsSync(); // must not throw
  assert.deepStrictEqual(bulkCalls.flat(), [{ id: 'n5', orderEarning: 20 }], 'the earning was still saved');

  // ---------- nothing waiting for an earning OR an ad fee: eBay is not called at all ----------
  reset();
  await runOrderEarningsSync();
  assert.strictEqual(financesCalls.length, 0);

  console.log('order earnings sync tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
