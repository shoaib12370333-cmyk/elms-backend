// models/schemas/Order.js, the AliExpress order part: the states the code relies on are the only ones the database accepts, and the sync
// job's work list has its own small (partial) index instead of scanning every order.
const assert = require('assert');
const Order = require('../models/schemas/Order');

const base = { userId: '64f0c1e2a3b4c5d6e7f80901', ebayAccountId: '64f0c1e2a3b4c5d6e7f80902', ebayOrderId: 'E1', sku: 'S1' };
const check = (aliexpressOrder) => new Order({ ...base, aliexpressOrder }).validateSync();

for (const state of ['placing', 'placed', 'failed', 'unknown', null]) assert.strictEqual(check({ state }), undefined, 'state ' + state);
for (const payState of ['unpaid', 'paying', 'paid', null]) assert.strictEqual(check({ state: 'placed', payState }), undefined, 'payState ' + payState);
assert.ok(check({ state: 'bought' }), 'an unknown state is refused');
assert.ok(check({ state: 'placed', payState: 'refunded' }), 'an unknown pay state is refused');
const o = new Order({ ...base, aliexpressOrder: { state: 'placed', payState: 'paying', payingAt: new Date('2026-10-03T12:00:00Z') } });
assert.strictEqual(o.aliexpressOrder.payingAt.toISOString(), '2026-10-03T12:00:00.000Z', 'the time a payment request was sent is kept');

const indexes = Order.schema.indexes();
const syncIndex = indexes.find(([fields]) => fields['aliexpressOrder.state'] === 1);
assert.ok(syncIndex, 'the sync job\'s query has an index');
assert.deepStrictEqual(syncIndex[0], { 'aliexpressOrder.state': 1, 'aliexpressOrder.placedAt': -1 });
assert.deepStrictEqual(syncIndex[1].partialFilterExpression, { 'aliexpressOrder.state': { $exists: true } }, 'only the few lines that have an AliExpress order are in it');

console.log('aliexpress order schema tests passed');
