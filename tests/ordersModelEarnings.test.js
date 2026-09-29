// models/ordersModel.js listOrdersNeedingEarnings/setOrderEarningsBulk: the exact Mongo filter used to find orders still
// waiting for their eBay-fetched earning, and that a bulk save never overwrites an earning that is already set.
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let lastFindFilter = null;
let lastBulkOps = null;
stub('../models/schemas/Order', {
  find: (filter) => { lastFindFilter = filter; return { select: () => ({ lean: async () => [] }) }; },
  bulkWrite: async (ops) => { lastBulkOps = ops; return { modifiedCount: ops.length }; },
});
stub('../models/schemas/Listing', {});
stub('../models/schemas/Import', {});
stub('../services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('../config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('../services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const { listOrdersNeedingEarnings, setOrderEarningsBulk } = require('../models/ordersModel');

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

  console.log('orders model earnings tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
