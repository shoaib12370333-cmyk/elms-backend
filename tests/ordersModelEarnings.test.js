// models/ordersModel.js listOrdersNeedingEarnings/setOrderEarningsBulk: the exact Mongo filter used to find orders still
// waiting for their eBay-fetched earning, and that a bulk save never overwrites an earning that is already set.
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let lastFindFilter = null;
let lastFindOpts = null;
let lastBulkOps = null;
let lastUpdateMany = null;
stub('../models/schemas/Order', {
  find: (filter) => {
    lastFindFilter = filter; lastFindOpts = {};
    const chain = { sort: (s) => { lastFindOpts.sort = s; return chain; }, limit: (n) => { lastFindOpts.limit = n; return chain; }, select: (f) => { lastFindOpts.select = f; return chain; }, lean: async () => [] };
    return chain;
  },
  bulkWrite: async (ops) => { lastBulkOps = ops; return { modifiedCount: ops.length }; },
  updateMany: async (filter, update) => { lastUpdateMany = { filter, update }; return { modifiedCount: 3 }; },
});
stub('../models/schemas/Listing', {});
stub('../models/schemas/Import', {});
stub('../services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('../config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('../services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const { listOrdersNeedingEarnings, setOrderEarningsBulk, listOrdersNeedingAdFee, setOrderAdFeesBulk, markAdFeeChecked } = require('../models/ordersModel');

(async () => {
  // ---------- listOrdersNeedingEarnings: fully paid, no earning yet, has an eBay order id, paid at least minAgeMs ago ----------
  const before = Date.now();
  await listOrdersNeedingEarnings('acc1', 24 * 60 * 60 * 1000);
  assert.strictEqual(lastFindFilter.ebayAccountId, 'acc1');
  assert.strictEqual(lastFindFilter.orderEarning, null);
  assert.strictEqual(lastFindFilter.ebayPaymentStatus, 'PAID', 'a partially paid/refunded order is never picked up in v1 - and PAID, not FULLY_PAID, is the real eBay OrderPaymentStatusEnum value');
  assert.deepStrictEqual(lastFindFilter.ebayOrderId, { $ne: null });
  assert.strictEqual(lastFindFilter.paidAt.$ne, null);
  const cutoffMs = lastFindFilter.paidAt.$lt.getTime();
  assert.ok(cutoffMs <= before - 24 * 60 * 60 * 1000 + 1000 && cutoffMs >= before - 24 * 60 * 60 * 1000 - 5000, 'the cutoff is ~24h in the past');

  // ---------- setOrderEarningsBulk: only writes rows that still have orderEarning: null, rounds to cents, skips a non-numeric ----------
  const modified = await setOrderEarningsBulk([{ id: 'l1', orderEarning: 12.345 }, { id: 'l2', orderEarning: NaN }, { id: 'l3', orderEarning: 8 }]);
  assert.strictEqual(modified, 2, 'the NaN one never reaches Mongo at all');
  assert.strictEqual(lastBulkOps.length, 2);
  assert.strictEqual(lastBulkOps[0].updateOne.filter.orderEarning, null, 'never overwrites a value that is already set - by a previous auto-fill or a manual Net Profit edit');
  assert.strictEqual(lastBulkOps[0].updateOne.update.$set.orderEarning, 12.35, 'rounded to cents');
  assert.strictEqual(lastBulkOps[1].updateOne.update.$set.orderEarning, 8);

  assert.strictEqual(await setOrderEarningsBulk([]), 0);
  assert.strictEqual(await setOrderEarningsBulk([{ id: null, orderEarning: 5 }]), 0, 'an update with no id is dropped, never crashes');

  assert.match(lastFindOpts.select, /ebayLineItemId/, 'the earning job also needs eBay\'s line item id, to give each line its own ad fee');

  // ---------- listOrdersNeedingAdFee: lines that HAVE an earning but never had their ad fee read, newest first, bounded, tried once ----------
  const adFeeBefore = Date.now();
  await listOrdersNeedingAdFee('u1', 'acc1', 10, 3 * 24 * 60 * 60 * 1000);
  assert.strictEqual(lastFindFilter.userId, 'u1', 'userId is in the filter so the (userId, ebayAccountId, createdAt) index can be used');
  assert.strictEqual(lastFindFilter.ebayAccountId, 'acc1');
  assert.deepStrictEqual(lastFindFilter.orderEarning, { $ne: null }, 'only orders that already have their earning - the new ones get their ad fee together with it');
  assert.strictEqual(lastFindFilter.adFee, null);
  assert.strictEqual(lastFindFilter.adFeeCheckedAt, null, 'an order eBay had nothing for is not asked about again');
  assert.strictEqual(lastFindFilter.ebayPaymentStatus, 'PAID');
  assert.deepStrictEqual(lastFindFilter.ebayOrderId, { $ne: null });
  assert.strictEqual(lastFindFilter.paidAt.$ne, null);
  const adCutoff = lastFindFilter.paidAt.$lt.getTime();
  assert.ok(adCutoff <= adFeeBefore - 3 * 24 * 60 * 60 * 1000 + 1000 && adCutoff >= adFeeBefore - 3 * 24 * 60 * 60 * 1000 - 5000, 'only orders paid 3+ days ago: eBay has settled them, so "nothing there" is final');
  assert.deepStrictEqual(lastFindOpts.sort, { createdAt: -1 });
  assert.strictEqual(lastFindOpts.limit, 10);
  assert.match(lastFindOpts.select, /ebayLineItemId/);

  // ---------- setOrderAdFeesBulk: only rows whose adFee is still null, cents, a real 0 kept, a non-number / no id dropped ----------
  const savedFees = await setOrderAdFeesBulk([{ id: 'l1', adFee: 1.234 }, { id: 'l2', adFee: 0 }, { id: 'l3', adFee: NaN }, { id: null, adFee: 5 }, { id: 'l4', adFee: -0 }]);
  assert.strictEqual(savedFees, 3, 'NaN and the id-less one never reach Mongo');
  assert.strictEqual(lastBulkOps.length, 3);
  assert.strictEqual(lastBulkOps[0].updateOne.filter.adFee, null, 'never overwrites a fee that is already set');
  assert.strictEqual(lastBulkOps[0].updateOne.update.$set.adFee, 1.23, 'rounded to cents');
  assert.strictEqual(lastBulkOps[1].updateOne.update.$set.adFee, 0, 'fetched and there was none: stored as 0, which is NOT the same as not fetched (null)');
  assert.ok(Object.is(lastBulkOps[2].updateOne.update.$set.adFee, 0), 'a -0 is stored as a plain 0');
  assert.strictEqual(await setOrderAdFeesBulk([]), 0);

  // ---------- markAdFeeChecked: stamps only lines not stamped before ----------
  assert.strictEqual(await markAdFeeChecked(['a', 'b', null]), 3);
  assert.deepStrictEqual(lastUpdateMany.filter, { _id: { $in: ['a', 'b'] }, adFeeCheckedAt: null });
  assert.ok(lastUpdateMany.update.$set.adFeeCheckedAt instanceof Date);
  lastUpdateMany = null;
  assert.strictEqual(await markAdFeeChecked([]), 0);
  assert.strictEqual(lastUpdateMany, null, 'nothing to stamp: no database call');

  console.log('orders model earnings tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
