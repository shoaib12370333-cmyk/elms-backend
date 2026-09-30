// services/orderSyncService.js's per-order loop: one order's own data being unexpected must never stop every order
// that comes after it in eBay's response for that account, and must never be silently repeated forever - it used
// to (a single throw escaped both loops), which meant every order after the bad one in eBay's response was skipped,
// on this run AND every future run (the loop always starts from the same place). Isolating each order lets its
// siblings save normally; lastSyncAttemptAt still advances so the bad order itself is retried on the NEXT sync via
// the existing 48-hour overlap window, rather than the whole account being stuck.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let rawOrders = [];
let lineItemsFor = () => [{ lineItem: 'x' }];
const saved = [];
let failOnLine = null; // a lineItem object that upsertOrder should throw for
const updates = [];

stub('services/ebayOrdersService', {
  fetchOrders: async () => rawOrders,
  normalizeOrderLineItems: (rawOrder) => lineItemsFor(rawOrder),
});
stub('models/ordersModel', {
  upsertOrder: async (userId, lineItem, accountId) => {
    if (failOnLine && lineItem === failOnLine) throw new Error('Duplicate key-ish real error.');
    saved.push({ userId, lineItem, accountId });
  },
});
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => 'rt' });
stub('models/schemas/EbayAccount', {
  findById: async () => ({ lastSyncAttemptAt: null }),
  updateOne: async (q, fields) => { updates.push({ accountId: String(q._id), fields }); },
});
stub('services/orderImageService', { fillMissingOrderImages: async () => {} });

const { syncAccountOrders } = require('../services/orderSyncService');
const reset = () => { saved.length = 0; updates.length = 0; failOnLine = null; };

(async () => {
  // ---------- the happy path: every order's line items save ----------
  reset();
  rawOrders = [{ orderId: 'O1' }, { orderId: 'O2' }];
  lineItemsFor = (o) => [{ id: o.orderId + '-1' }];
  let out = await syncAccountOrders('u1', 'acc1');
  assert.deepStrictEqual(out, { ordersFromEbay: 2, savedCount: 2, failedCount: 0 });
  assert.deepStrictEqual(saved.map((s) => s.lineItem.id), ['O1-1', 'O2-1']);
  assert.strictEqual(updates.length, 1, 'lastSyncAttemptAt is advanced');

  // ---------- one order in the MIDDLE throws: the orders before AND after it still save - the bug ----------
  reset();
  rawOrders = [{ orderId: 'O1' }, { orderId: 'O2' }, { orderId: 'O3' }];
  const badLine = { id: 'O2-bad' };
  lineItemsFor = (o) => (o.orderId === 'O2' ? [badLine] : [{ id: o.orderId + '-1' }]);
  failOnLine = badLine;
  out = await syncAccountOrders('u1', 'acc1');
  assert.deepStrictEqual(saved.map((s) => s.lineItem.id), ['O1-1', 'O3-1'], 'O1 and O3 both saved even though O2 (in between) failed - previously O3 would never even be attempted');
  assert.deepStrictEqual(out, { ordersFromEbay: 3, savedCount: 2, failedCount: 1 });
  assert.strictEqual(updates.length, 1, 'lastSyncAttemptAt still advances - the failed order is naturally retried next run via the 48h overlap, not by re-fetching everything now');

  // ---------- a bad order's own multiple line items: the first line's failure does not stop that SAME order's other lines from being tried ----------
  reset();
  rawOrders = [{ orderId: 'O4' }];
  const bad2 = { id: 'O4-bad' };
  lineItemsFor = () => [bad2, { id: 'O4-good' }];
  failOnLine = bad2;
  out = await syncAccountOrders('u1', 'acc1');
  assert.strictEqual(out.failedCount, 1, 'one order that itself throws counts as one failed order, not per-line-item');
  assert.strictEqual(out.savedCount, 0, 'the throw happens on the first line, so the second line of the SAME order (inside the same try) is never reached - a within-order ordering detail, not a cross-order one');

  console.log('order sync service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
