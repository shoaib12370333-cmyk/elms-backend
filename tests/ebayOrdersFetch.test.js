// services/ebayOrdersService.js fetchOrders: paginates eBay's Fulfillment API 200 at a time. A hard 50-page cap
// exists as a backstop, but if it is ever actually reached there ARE more orders on eBay past that point that were
// never fetched - this used to be completely silent (the caller had no way to know the result was incomplete), so a
// seller with enough orders modified in one sync window could silently lose some, forever (each later sync's
// window starts from lastSyncAttemptAt, which still advances, so the missed ones are never revisited). Now it logs
// clearly when that happens.
const assert = require('assert');

const authPath = require.resolve('../services/ebayAuthService');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { getAccessToken: async () => 'AT' } };

let pageSizes = [];
let callCount = 0;
const axiosPath = require.resolve('axios');
const page200 = Array.from({ length: 200 }, (_, i) => ({ orderId: 'O' + i }));
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { get: async () => { const size = pageSizes[callCount] ?? 0; callCount += 1; return { data: { orders: size === 200 ? page200 : Array.from({ length: size }, (_, i) => ({ orderId: 'O' + i })) } }; } },
};

const errors = [];
const origError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); };

const { fetchOrders } = require('../services/ebayOrdersService');

(async () => {
  // ---------- ordinary pagination: stops as soon as a page comes back short, no warning ----------
  callCount = 0; errors.length = 0;
  pageSizes = [200, 200, 50];
  let orders = await fetchOrders('rt', new Date());
  assert.strictEqual(orders.length, 450);
  assert.strictEqual(callCount, 3, 'stops at the first short page - does not keep paging once eBay says there is no more');
  assert.strictEqual(errors.length, 0, 'the ordinary case logs nothing');

  // ---------- every one of the 50 allowed pages comes back full: the cap is hit with more still on eBay - this must be logged, not silent ----------
  callCount = 0; errors.length = 0;
  pageSizes = Array.from({ length: 60 }, () => 200); // more pages available than the 50-page cap allows
  orders = await fetchOrders('rt', new Date());
  assert.strictEqual(callCount, 50, 'never asks for more than the 50-page cap');
  assert.strictEqual(orders.length, 50 * 200);
  assert.strictEqual(errors.length, 1, 'hitting the cap while eBay still had more is logged, not silently treated as "done"');
  assert.match(errors[0], /50-page limit/);

  console.error = origError;
  console.log('ebay orders fetch tests passed');
})().catch((e) => { console.error = origError; console.error(e); process.exit(1); });
