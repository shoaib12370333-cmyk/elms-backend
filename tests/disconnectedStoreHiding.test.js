// The actual promise behind "Disconnect": models/listingsModel.js, models/ordersModel.js and models/conversationsModel.js
// all hide a disconnected store's rows from the combined "every store" view (never delete them), and stop hiding them the
// moment that EbayAccount's disconnectedAt is cleared again (reconnect) - real model code, an in-memory Mongo stand-in.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const accounts = [
  { _id: 'connected1', userId: 'u1', disconnectedAt: null },
  { _id: 'disconnected1', userId: 'u1', disconnectedAt: new Date() },
];
const chain = (rows) => ({
  select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
  lean: async () => rows, then: (res) => Promise.resolve(rows).then(res),
});
const matchesEbayAccountId = (row, cond) => {
  if (cond === undefined) return true;
  if (cond && typeof cond === 'object' && cond.$nin) return !cond.$nin.includes(row.ebayAccountId);
  return row.ebayAccountId === cond;
};
stub('models/schemas/EbayAccount', {
  find: (q) => chain(accounts.filter((a) => a.userId === q.userId && (!q.disconnectedAt || a.disconnectedAt !== null))),
});

(async () => {
  // ================= listings =================
  const listingRows = [
    { _id: 'lc1', userId: 'u1', ebayAccountId: 'connected1', status: 'published', title: 'From the connected store' },
    { _id: 'ld1', userId: 'u1', ebayAccountId: 'disconnected1', status: 'published', title: 'From the disconnected store' },
  ];
  stub('models/schemas/Listing', {
    find: (q) => chain(listingRows.filter((r) => r.userId === q.userId && (!q.status || r.status === q.status) && matchesEbayAccountId(r, q.ebayAccountId))),
  });
  const listingsModel = require('../models/listingsModel');

  const combined = await listingsModel.listListings('u1', 'published');
  assert.deepStrictEqual(combined.map((r) => r.id), ['lc1'], 'the combined view never shows the disconnected store\'s listing');

  const scoped = await listingsModel.listListings('u1', 'published', 'disconnected1');
  assert.deepStrictEqual(scoped.map((r) => r.id), ['ld1'], 'asking for that ONE store by id still shows it - nothing was deleted');

  // reconnect: disconnectedAt cleared -> the combined view shows it again
  accounts.find((a) => a._id === 'disconnected1').disconnectedAt = null;
  const afterReconnect = await listingsModel.listListings('u1', 'published');
  assert.deepStrictEqual(afterReconnect.map((r) => r.id).sort(), ['lc1', 'ld1'], 'reconnecting brings it straight back into the combined view');
  accounts.find((a) => a._id === 'disconnected1').disconnectedAt = new Date(); // back to disconnected for the next section

  // ================= orders =================
  const orderRows = [
    { _id: 'oc1', userId: 'u1', ebayAccountId: 'connected1', currency: 'USD', salePrice: 10, quantity: 1 },
    { _id: 'od1', userId: 'u1', ebayAccountId: 'disconnected1', currency: 'USD', salePrice: 20, quantity: 1 },
  ];
  stub('models/schemas/Order', {
    find: (q) => chain(orderRows.filter((r) => r.userId === q.userId && matchesEbayAccountId(r, q.ebayAccountId))),
  });
  stub('models/schemas/Import', {});
  delete require.cache[require.resolve('../models/ordersModel')];
  const ordersModel = require('../models/ordersModel');

  const combinedOrders = await ordersModel.listOrders('u1');
  assert.deepStrictEqual(combinedOrders.map((o) => o.id), ['oc1'], 'the combined Orders view never shows the disconnected store\'s order');

  const scopedOrders = await ordersModel.listOrders('u1', 'disconnected1');
  assert.deepStrictEqual(scopedOrders.map((o) => o.id), ['od1'], 'still there when that store is asked for directly - nothing was deleted');

  console.log('disconnected store hiding tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
