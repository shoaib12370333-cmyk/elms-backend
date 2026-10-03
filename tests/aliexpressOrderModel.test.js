// models/ordersModel.js, the AliExpress order of a line: claimAliexpressOrder is ONE atomic update that only succeeds from "none" /
// "failed" (and "unknown" only when the seller confirmed), updateAliexpressOrder writes only the keys it knows, the sync job's work
// list and the stale-claim expiry ask the right questions, and the serialized order shows the AliExpress order (and the listing's source).
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const seen = { findOneAndUpdate: [], updateMany: [], find: [] };
let findResult = [];
stub('../models/schemas/Order', {
  findOneAndUpdate: async (filter, update, opts) => { seen.findOneAndUpdate.push({ filter, update, opts }); return seen.next === undefined ? { _id: 'o1', userId: 'u1', aliexpressOrder: { state: 'placing' } } : seen.next; },
  updateMany: async (filter, update) => { seen.updateMany.push({ filter, update }); return { modifiedCount: 2 }; },
  find: (filter) => {
    const entry = { filter }; seen.find.push(entry);
    const chain = { sort: (s) => { entry.sort = s; return chain; }, limit: (n) => { entry.limit = n; return chain; }, select: (f) => { entry.select = f; return chain; }, lean: async () => findResult };
    return chain;
  },
});
stub('../models/schemas/Listing', {});
stub('../models/schemas/Import', {});
stub('../services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('../config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('../services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const M = require('../models/ordersModel');

(async () => {
  // ---------- claimAliexpressOrder: one atomic update, from none / failed only ----------
  await M.claimAliexpressOrder('u1', 'o1');
  let call = seen.findOneAndUpdate[0];
  assert.deepStrictEqual(call.filter, { _id: 'o1', userId: 'u1', 'aliexpressOrder.state': { $in: [null, 'failed'] } }, 'a missing / null / failed state may be claimed - never placing, placed or unknown');
  assert.strictEqual(call.update.$set['aliexpressOrder.state'], 'placing');
  assert.ok(call.update.$set['aliexpressOrder.claimedAt'] instanceof Date);
  assert.strictEqual(call.update.$set['aliexpressOrder.error'], null);
  assert.strictEqual(call.update.$set['aliexpressOrder.errorCode'], null);
  assert.strictEqual(call.opts.new, true);

  await M.claimAliexpressOrder('u1', 'o1', { retryUnknown: true });
  assert.deepStrictEqual(seen.findOneAndUpdate[1].filter['aliexpressOrder.state'], { $in: [null, 'failed', 'unknown'] }, 'unknown only after the seller confirmed they checked AliExpress');

  seen.next = null;
  assert.strictEqual(await M.claimAliexpressOrder('u1', 'o1'), null, 'not claimable -> null');
  seen.next = undefined;
  const claimed = await M.claimAliexpressOrder('u1', 'o1');
  assert.strictEqual(claimed.aliexpress_order.state, 'placing', 'the claimed order is serialized');

  // ---------- claimAliexpressPayment: one atomic update, from unpaid only (or a payment request that has been in flight far too long) ----------
  seen.findOneAndUpdate.length = 0;
  seen.next = undefined;
  const payNow = Date.parse('2026-10-03T12:00:00Z');
  await M.claimAliexpressPayment('u1', 'o1', { now: payNow });
  call = seen.findOneAndUpdate[0];
  assert.deepStrictEqual(call.filter, {
    _id: 'o1', userId: 'u1', 'aliexpressOrder.state': 'placed',
    $or: [
      { 'aliexpressOrder.payState': { $in: [null, 'unpaid'] } },
      { 'aliexpressOrder.payState': 'paying', 'aliexpressOrder.payingAt': { $lt: new Date(payNow - 15 * 60 * 1000) } },
    ],
  }, 'a placed order that is unpaid (or whose payment request is older than 15 minutes) - never paid, never one in flight');
  assert.deepStrictEqual(call.update, { $set: { 'aliexpressOrder.payState': 'paying', 'aliexpressOrder.payingAt': new Date(payNow) } });
  assert.strictEqual(call.opts.new, true);
  await M.claimAliexpressPayment('u1', 'o1', { now: payNow, staleMs: 60000 });
  assert.deepStrictEqual(seen.findOneAndUpdate[1].filter.$or[1]['aliexpressOrder.payingAt'], { $lt: new Date(payNow - 60000) });
  seen.next = null;
  assert.strictEqual(await M.claimAliexpressPayment('u1', 'o1'), null, 'not claimable -> null');
  seen.next = undefined;
  assert.strictEqual((await M.claimAliexpressPayment('u1', 'o1')).id, 'o1', 'the claimed order is serialized');

  // releasing the claim: only a payment that is still "paying" goes back to unpaid - a paid order stays paid
  seen.findOneAndUpdate.length = 0;
  await M.releaseAliexpressPayment('u1', 'o1');
  call = seen.findOneAndUpdate[0];
  assert.deepStrictEqual(call.filter, { _id: 'o1', userId: 'u1', 'aliexpressOrder.payState': 'paying' });
  assert.deepStrictEqual(call.update, { $set: { 'aliexpressOrder.payState': 'unpaid' } });
  seen.next = null;
  assert.strictEqual(await M.releaseAliexpressPayment('u1', 'o1'), null);
  seen.next = undefined;

  // the payment-in-flight time and state can be written like the other keys
  seen.findOneAndUpdate.length = 0;
  await M.updateAliexpressOrder('u1', 'o1', { payState: 'paying', payingAt: new Date(payNow) });
  assert.deepStrictEqual(seen.findOneAndUpdate[0].update.$set, { 'aliexpressOrder.payState': 'paying', 'aliexpressOrder.payingAt': new Date(payNow) });
  seen.findOneAndUpdate.length = 0;

  // ---------- updateAliexpressOrder: only known keys, only those given ----------
  seen.findOneAndUpdate.length = 0;
  await M.updateAliexpressOrder('u1', 'o1', { state: 'placed', aeOrderId: '5001', amount: 12.5, payState: 'unpaid', evil: 'x', userId: 'other', 'state.$': 1, status: undefined });
  call = seen.findOneAndUpdate[0];
  assert.deepStrictEqual(call.filter, { _id: 'o1', userId: 'u1' }, 'always the seller\'s own order');
  assert.deepStrictEqual(call.update.$set, { 'aliexpressOrder.state': 'placed', 'aliexpressOrder.aeOrderId': '5001', 'aliexpressOrder.amount': 12.5, 'aliexpressOrder.payState': 'unpaid' }, 'unknown keys and undefined values are not written');
  seen.findOneAndUpdate.length = 0;
  assert.strictEqual(await M.updateAliexpressOrder('u1', 'o1', { nothing: 1 }), null);
  assert.strictEqual(await M.updateAliexpressOrder('u1', 'o1', {}), null);
  assert.strictEqual(seen.findOneAndUpdate.length, 0, 'nothing to write: no database call');
  await M.updateAliexpressOrder('u1', 'o1', { error: null, finished: false });
  assert.deepStrictEqual(seen.findOneAndUpdate[0].update.$set, { 'aliexpressOrder.error': null, 'aliexpressOrder.finished': false }, 'null and false are real values');

  // a CONDITIONAL write: every condition given must still hold, so a slow reader can never overwrite what happened in between
  seen.findOneAndUpdate.length = 0;
  await M.updateAliexpressOrder('u1', 'o1', { state: 'failed' }, { state: 'placed', aeOrderId: 5001, payStateNotIn: ['paid', 'paying'] });
  assert.deepStrictEqual(seen.findOneAndUpdate[0].filter, { _id: 'o1', userId: 'u1', 'aliexpressOrder.state': 'placed', 'aliexpressOrder.aeOrderId': '5001', 'aliexpressOrder.payState': { $nin: ['paid', 'paying'] } });
  seen.findOneAndUpdate.length = 0;
  await M.updateAliexpressOrder('u1', 'o1', { syncedAt: new Date() }, { state: 'placed' });
  assert.deepStrictEqual(seen.findOneAndUpdate[0].filter, { _id: 'o1', userId: 'u1', 'aliexpressOrder.state': 'placed' }, 'only the conditions that are given');
  seen.findOneAndUpdate.length = 0;
  await M.updateAliexpressOrder('u1', 'o1', { syncedAt: new Date() }, null);
  await M.updateAliexpressOrder('u1', 'o1', { syncedAt: new Date() });
  assert.deepStrictEqual(seen.findOneAndUpdate.map((c) => c.filter), [{ _id: 'o1', userId: 'u1' }, { _id: 'o1', userId: 'u1' }], 'no guard: just the order of that seller');
  seen.next = null;
  assert.strictEqual(await M.updateAliexpressOrder('u1', 'o1', { state: 'failed' }, { state: 'placed' }), null, 'the condition no longer holds: nothing written');
  seen.next = undefined;
  seen.findOneAndUpdate.length = 0;

  // ---------- the sync job's work list ----------
  const now = Date.parse('2026-10-03T12:00:00Z');
  findResult = [{ _id: 'o1' }];
  const list = await M.listAliexpressOrdersToSync({ now });
  const q = seen.find[0];
  assert.deepStrictEqual(list, [{ _id: 'o1' }]);
  assert.strictEqual(q.filter['aliexpressOrder.state'], 'placed', 'only placed orders - never an unknown one (it may not exist)');
  assert.deepStrictEqual(q.filter['aliexpressOrder.finished'], { $ne: true });
  assert.strictEqual(q.filter['aliexpressOrder.placedAt'].$gt.getTime(), now - 150 * 24 * 60 * 60 * 1000, 'not older than ~5 months');
  assert.deepStrictEqual(q.filter.$or, [{ 'aliexpressOrder.syncedAt': null }, { 'aliexpressOrder.syncedAt': { $lt: new Date(now - 25 * 60 * 1000) } }], 'never synced, or not for 25 minutes');
  assert.deepStrictEqual([q.sort, q.limit], [{ 'aliexpressOrder.placedAt': -1 }, 200]);

  // ---------- a claim "in flight" for far too long becomes UNKNOWN ----------
  const expired = await M.expireStalePlacingAliexpressOrders({ now });
  assert.strictEqual(expired, 2);
  const exp = seen.updateMany[0];
  assert.deepStrictEqual(exp.filter, { 'aliexpressOrder.state': 'placing', 'aliexpressOrder.claimedAt': { $lt: new Date(now - 15 * 60 * 1000) } });
  assert.strictEqual(exp.update.$set['aliexpressOrder.state'], 'unknown');
  assert.match(exp.update.$set['aliexpressOrder.error'], /Check your AliExpress orders/);

  // ---------- the serialized order ----------
  // (serialize is not exported: the serialized order is read through claim / update, which return it)
  seen.next = {
    _id: 'o1', userId: 'u1', aliexpressOrder: {
      state: 'placed', aeOrderId: '5001', aeOrderIds: ['5001', '5002'], placedAt: new Date('2026-10-03T10:00:00Z'), payState: 'paid', status: 'WAIT_SELLER_SEND_GOODS',
      logisticsStatus: 'X', amount: 12.5, currency: 'USD', estimatedCost: 12.5, shippingService: 'CAINIAO_FULFILLMENT_STD', trackingNumber: 'T1', carrier: 'YunExpress',
      etaAt: new Date('2026-10-20T00:00:00Z'), lastEvent: 'Shipped', syncedAt: new Date('2026-10-03T11:00:00Z'), finished: false, error: null, errorCode: null, outOrderId: 'secret-internal',
    },
  };
  const view = (await M.claimAliexpressOrder('u1', 'o1')).aliexpress_order;
  assert.deepStrictEqual(Object.keys(view).sort(), ['ae_order_id', 'ae_order_ids', 'amount', 'carrier', 'currency', 'error', 'error_code', 'estimated_cost', 'eta_at', 'finished', 'last_event', 'logistics_status', 'paid_at', 'pay_state', 'paying_at', 'placed_at', 'shipping_service', 'state', 'status', 'synced_at', 'tracking_number']);
  assert.deepStrictEqual([view.state, view.ae_order_id, view.ae_order_ids, view.pay_state, view.amount, view.currency, view.tracking_number, view.carrier, view.finished], ['placed', '5001', ['5001', '5002'], 'paid', 12.5, 'USD', 'T1', 'YunExpress', false]);
  assert.ok(!('out_order_id' in view), 'ELMS\'s internal number is not exposed');
  seen.next = { _id: 'o1', userId: 'u1' };
  assert.strictEqual((await M.claimAliexpressOrder('u1', 'o1')).aliexpress_order, null, 'an order with none placed shows null');
  seen.next = { _id: 'o1', userId: 'u1', aliexpressOrder: { amount: null, estimatedCost: null, state: 'failed', error: 'x' } };
  const failedView = (await M.claimAliexpressOrder('u1', 'o1')).aliexpress_order;
  assert.deepStrictEqual([failedView.state, failedView.amount, failedView.estimated_cost, failedView.error, failedView.ae_order_ids], ['failed', null, null, 'x', []], 'unknown money is null, never 0');
  seen.next = { _id: 'o1', userId: 'u1', aliexpressOrder: { state: null } };
  assert.strictEqual((await M.claimAliexpressOrder('u1', 'o1')).aliexpress_order, null, 'no state = none started');

  console.log('aliexpress order model tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
