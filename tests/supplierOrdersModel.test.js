// The supplier order status machine (ready -> checking -> placing -> placed | needs_attention | failed) and the
// dedupe-by-ebayLineItemId guarantee - the same guarantee a unique Mongo index gives in production, reproduced here
// as an in-memory duplicate-key check so the model's behavior is tested without a real database.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let rows = {};
let seq = 0;
const dupErr = () => { const e = new Error('E11000 duplicate key'); e.code = 11000; return e; };

stub('models/schemas/SupplierOrder', {
  create: async (data) => {
    if (Object.values(rows).some((r) => r.ebayLineItemId === data.ebayLineItemId)) throw dupErr();
    const doc = { _id: 'so' + (++seq), status: 'pending', ...data, createdAt: new Date(Date.now() + seq) };
    rows[doc._id] = doc;
    return doc;
  },
  findOne: ({ _id, userId }) => ({ _id, userId, then: (res) => res(rows[_id] && rows[_id].userId === userId ? rows[_id] : null) }),
  findOneAndUpdate: (filter, update, opts) => (async () => {
    let candidates = Object.values(rows).filter((r) => r.userId === filter.userId);
    if (filter._id) candidates = candidates.filter((r) => r._id === filter._id);
    if (filter.status) {
      const wanted = filter.status.$in || [filter.status];
      candidates = candidates.filter((r) => wanted.includes(r.status));
    }
    if (opts?.sort?.createdAt === 1) candidates.sort((a, b) => a.createdAt - b.createdAt);
    const doc = candidates[0];
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  })(),
  find: (query) => ({ sort: () => ({ lean: async () => Object.values(rows).filter((r) => r.userId === query.userId && (!query.status || (query.status.$in || [query.status]).includes(r.status))) }) }),
  aggregate: async () => [],
});

const {
  createSupplierOrder, claimNextReadyOrder, markPlacing, markPlaced, markNeedsAttention, markFailed, retrySupplierOrder, listSupplierOrders,
} = require('../models/supplierOrdersModel');

const fresh = (over = {}) => ({ userId: 'u1', ebayLineItemId: 'LI1', status: 'ready', shippingAddress: { city: 'X' }, ...over });

(async () => {
  // ---------- the unique-index guarantee: a second create for the same eBay line item is silently ignored, not thrown ----------
  rows = {}; seq = 0;
  const first = await createSupplierOrder(fresh());
  assert.ok(first);
  const second = await createSupplierOrder(fresh());
  assert.strictEqual(second, null, 'the same ebayLineItemId never creates a second supplier order');

  // ---------- the normal flow: ready -> checking (claimed) -> placing -> placed, address cleared ----------
  let claimed = await claimNextReadyOrder('u1');
  assert.strictEqual(claimed.status, 'checking');
  let placing = await markPlacing('u1', claimed.id);
  assert.strictEqual(placing.status, 'placing');
  let placed = await markPlaced('u1', claimed.id, { amazonOrderId: 'AMZ-1', amazonTotal: 19.99 });
  assert.strictEqual(placed.status, 'placed');
  assert.strictEqual(placed.amazon_order_id, 'AMZ-1');
  assert.strictEqual(placed.shipping_address, null, 'the buyer\'s address is cleared once placed - no longer needed');

  // ---------- claimNextReadyOrder returns null once nothing is 'ready' any more ----------
  assert.strictEqual(await claimNextReadyOrder('u1'), null);

  // ---------- a captcha/price-change/etc block: needs_attention, address kept (a human may retry it) ----------
  rows = {}; seq = 0;
  await createSupplierOrder(fresh({ ebayLineItemId: 'LI2' }));
  claimed = await claimNextReadyOrder('u1');
  await markPlacing('u1', claimed.id);
  let blocked = await markNeedsAttention('u1', claimed.id, 'The price on Amazon rose above the allowed limit.');
  assert.strictEqual(blocked.status, 'needs_attention');
  assert.deepStrictEqual(blocked.shipping_address, { city: 'X' }, 'kept: this can still be retried');
  assert.match(blocked.error, /price on Amazon rose/);

  // ---------- retrying a needs_attention order sends it back to 'ready' so the extension picks it up again ----------
  const retried = await retrySupplierOrder('u1', claimed.id, { shippingAddress: { city: 'X' } });
  assert.strictEqual(retried.status, 'ready');
  assert.strictEqual(retried.error, null);

  // ---------- an unexpected error: failed, address cleared (unlike needs_attention) ----------
  rows = {}; seq = 0;
  await createSupplierOrder(fresh({ ebayLineItemId: 'LI3' }));
  claimed = await claimNextReadyOrder('u1');
  const fail = await markFailed('u1', claimed.id, 'Amazon returned an unrecognized page.');
  assert.strictEqual(fail.status, 'failed');
  assert.strictEqual(fail.shipping_address, null);

  // ---------- placing/placed can never be called out of turn (e.g. placed on something still 'ready') ----------
  rows = {}; seq = 0;
  await createSupplierOrder(fresh({ ebayLineItemId: 'LI4' }));
  const stillReady = Object.values(rows)[0];
  assert.strictEqual(await markPlacing('u1', stillReady._id), null, 'placing requires checking first');
  assert.strictEqual(await markPlaced('u1', stillReady._id, { amazonOrderId: 'X' }), null, 'placed requires checking/placing first');

  // ---------- listSupplierOrders filters by status and only returns this user's own rows ----------
  rows = {}; seq = 0;
  await createSupplierOrder(fresh({ ebayLineItemId: 'LIA' }));
  await createSupplierOrder({ ...fresh({ ebayLineItemId: 'LIB' }), userId: 'u2' });
  const claimedA = await claimNextReadyOrder('u1');
  await markPlacing('u1', claimedA.id);
  await markNeedsAttention('u1', claimedA.id, 'Out of stock.');
  const mine = await listSupplierOrders('u1', { status: 'needs_attention' });
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].ebay_line_item_id, 'LIA');

  console.log('supplierOrdersModel: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
