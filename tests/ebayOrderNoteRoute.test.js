// The seller's switch for "also write ELMS: ordered in the eBay order note" (off by default) and POST /api/orders/:id/ebay-note: nothing is tried while the
// switch is off, the order must be the seller's, the store's token and site are used, the answer says what happened (written / removed / unchanged /
// skipped / failed) and the state is kept on the order for the order window. The real routes run; the models and eBay are stand-ins.
const assert = require('assert');
const Module = require('module');

let switchOn = false;
const userWrites = [];
let order = { id: 'o1', ebay_order_id: '11-12345-67890', legacy_item_id: '110001', ebay_account_id: 'a1', marketplace_id: 'EBAY_GB' };
const states = [];
const marks = [];
let markResult = (id, o) => (id === 'o1' ? { order: { id, fulfillment_status: o.ordered ? 'ordered_from_amazon' : 'pending', ordered_at: o.date || null, seller_note: 'ELMS: ordered', net_profit: 15 } } : { error: 'not_found' });
const syncCalls = [];
let syncResult = { status: 'written', note: 'ELMS: ordered 27 Sep 2026' };
let token = 'rt-1';
const query = (result) => { const q = { select: () => q, lean: async () => result }; return q; };
const fakes = {
  '../models/conversationsModel': { listConversations: async () => [], countUnreadConversations: async () => 0, upsertConversation: async () => null, addInternalNote: async () => null, updateConversationState: async () => null, trashConversation: async () => null, restoreConversation: async () => null, getConversationById: async () => null, getConversationForThread: async () => null, markConversationRead: async () => null },
  '../services/ebayBuyerProfileService': { PROFILE_TTL_MS: 1, ensureBuyerProfile: async () => null },
  '../services/messageAttachmentService': { saveMessageAttachment: async () => null, sanitizeAttachments: () => [] },
  '../models/schemas/EbayAccount': { findById: () => query(null) },
  '../models/messagesModel': { listMessages: async () => [], upsertMessages: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => token, listEbayAccounts: async () => [], getEbayAccountById: async (u, id) => (id === 'a1' ? { id: 'a1', marketplaceId: 'EBAY_GB' } : null) },
  '../services/ebayMessageService': { fetchConversationDetail: async () => ({}), sendMessage: async () => null, updateConversationStatus: async () => null },
  '../models/schemas/Order': { findOne: () => query(null) },
  '../models/schemas/Listing': { findOne: () => query(null) },
  '../jobs/conversationSync': { syncConversationsForUser: async () => ({}) },
  '../models/ordersModel': {
    ordersSummary: async () => ({}), listOrders: async () => [], updateFulfillmentStatus: async () => null, upsertOrder: async () => null, setTracking: async () => null, linkAmazonOrder: async () => null, setSellerNote: async () => null, setBuyPrice: async () => null, linkOrderToListing: async () => null,
    getOrderById: async (u, id) => (id === 'o1' ? order : null),
    markOrdered: async (u, id, o) => { marks.push([id, o]); return markResult(id, o); },
    setEbayNoteState: async (u, id, state) => { states.push([id, state]); return { ...order, ebay_note_at: state.written === true ? '2026-09-27T10:00:00Z' : null, ebay_note_error: state.error }; },
  },
  '../services/ebayOrdersService': { fetchOrderById: async () => null, normalizeOrderLineItems: () => [], createShippingFulfillment: async () => null },
  '../services/orderSyncService': { syncAccountOrders: async () => ({}) },
  '../services/orderImageService': { backfillOrderImagesForUser: () => {}, fillMissingOrderImages: async () => {} },
  '../routes/fetchProduct': { fetchAndSaveDraft: async () => null },
  '../models/usersModel': { hasCredits: async () => true },
  // loaded by the routes when they run
  '../models/schemas/User': { findById: () => query({ ebayOrderNote: switchOn }), updateOne: async (q, u) => { userWrites.push(u.$set); switchOn = u.$set.ebayOrderNote; } },
  '../services/ebayOrderNoteService': { syncOrderNote: async (t, mp, o) => { syncCalls.push([t, mp, o]); return syncResult; } },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes[\\/]orders\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const orders = require('../routes/orders');

const handler = (method, p) => { const l = orders.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, req) => { const res = fakeRes(); await handler(method, p)({ userId: 'u1', query: {}, body: {}, params: {}, ...req }, res); return res; };
const reset = () => { states.length = 0; syncCalls.length = 0; syncResult = { status: 'written', note: 'ELMS: ordered 27 Sep 2026' }; token = 'rt-1'; };

(async () => {
  // ---------- the switch: off until the seller turns it on ----------
  let res = await call('get', '/ebay-note-setting'); assert.deepStrictEqual(res.body, { success: true, enabled: false });
  res = await call('put', '/ebay-note-setting', { body: { enabled: 'yes' } }); assert.strictEqual(res.statusCode, 400); assert.strictEqual(userWrites.length, 0);
  res = await call('put', '/ebay-note-setting', { body: { enabled: true } }); assert.deepStrictEqual(res.body, { success: true, enabled: true }); assert.deepStrictEqual(userWrites, [{ ebayOrderNote: true }]);
  res = await call('get', '/ebay-note-setting'); assert.strictEqual(res.body.enabled, true);
  res = await call('put', '/ebay-note-setting', { body: { enabled: false } }); assert.strictEqual(res.body.enabled, false);

  // ---------- switched off: nothing is tried ----------
  reset(); switchOn = false;
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } });
  assert.strictEqual(res.statusCode, 403); assert.match(res.body.error, /switched off/); assert.strictEqual(syncCalls.length, 0); assert.strictEqual(states.length, 0);

  // ---------- switched on ----------
  switchOn = true;
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: {} }); assert.strictEqual(res.statusCode, 400, 'ordered must be true or false');
  res = await call('post', '/:id/ebay-note', { params: { id: 'nope' }, body: { ordered: true } }); assert.strictEqual(res.statusCode, 404); assert.strictEqual(syncCalls.length, 0, 'not the seller\'s order');
  // written: the store's token and eBay site, eBay's order and item numbers
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } });
  assert.strictEqual(res.body.success, true); assert.strictEqual(res.body.result.status, 'written');
  assert.deepStrictEqual(syncCalls[0], ['rt-1', 'EBAY_GB', { orderId: '11-12345-67890', itemId: '110001', ordered: true }]);
  assert.deepStrictEqual(states[0], ['o1', { written: true, error: null }], 'the mark is in the eBay note; no problem');
  assert.ok(res.body.order.ebay_note_at && res.body.order.ebay_note_error === null);
  // undone
  reset(); syncResult = { status: 'removed', note: '' };
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: false } });
  assert.deepStrictEqual(states[0], ['o1', { written: false, error: null }], 'the mark is out of the eBay note'); assert.strictEqual(syncCalls[0][2].ordered, false);
  // it was there already
  reset(); syncResult = { status: 'unchanged', message: 'The eBay note already says it.' };
  await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } }); assert.deepStrictEqual(states[0][1], { written: true, error: null });
  // it could not be done: the reason is kept, the mark in eBay stays as it was, and the ELMS mark is not affected (this route answers 200)
  reset(); syncResult = { status: 'failed', message: 'The token is not allowed to read your sales.' };
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } });
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.result.status, 'failed'); assert.deepStrictEqual(states[0][1], { written: null, error: 'The token is not allowed to read your sales.' });
  assert.strictEqual(res.body.order.ebay_note_error, 'The token is not allowed to read your sales.');
  reset(); syncResult = { status: 'skipped', message: 'eBay does not list this order as awaiting shipment.' };
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } }); assert.strictEqual(res.body.result.status, 'skipped'); assert.strictEqual(states[0][1].error, 'eBay does not list this order as awaiting shipment.');
  // an order with no store
  reset(); order = { ...order, ebay_account_id: null };
  res = await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } }); assert.strictEqual(res.body.result.status, 'skipped'); assert.strictEqual(syncCalls.length, 0);
  order = { ...order, ebay_account_id: 'a1' };
  // a store that lost its token: the service says why
  reset(); token = null; syncResult = { status: 'skipped', message: 'The eBay store is not connected.' };
  await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true } }); assert.strictEqual(syncCalls[0][0], null);

  // ---------- the date the seller chose goes to the eBay note too ----------
  reset();
  await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true, date: '2026-09-20' } });
  assert.strictEqual(syncCalls[0][2].now.toISOString(), '2026-09-20T12:00:00.000Z', 'noon UTC: no time zone can move it to another day');
  reset(); await call('post', '/:id/ebay-note', { params: { id: 'o1' }, body: { ordered: true, date: 'nonsense' } });
  assert.ok(!('now' in syncCalls[0][2]), 'not a date: today is used');

  // ---------- Mark as ordered with the date, the buying price and the order earning ----------
  const ordered = (body, id = 'o1') => call('post', '/:id/ordered', { params: { id }, body });
  res = await ordered({}); assert.strictEqual(res.statusCode, 400); assert.strictEqual(marks.length, 0);
  res = await ordered({ ordered: true, date: 'not a date' }); assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /Choose the date/);
  res = await ordered({ ordered: true, date: '2026-02-31' }); assert.strictEqual(res.statusCode, 400, 'a day that does not exist');
  res = await ordered({ ordered: true, date: '2999-01-01' }); assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /future/);
  res = await ordered({ ordered: true, date: '2026-09-20', buyingPrice: 'abc' }); assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /buying price as a number/);
  res = await ordered({ ordered: true, date: '2026-09-20', buyingPrice: -1 }); assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /0 or more/);
  res = await ordered({ ordered: true, date: '2026-09-20', orderEarning: 'x' }); assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /order earning as a number/);
  res = await ordered({ ordered: true, date: '2026-09-20', orderEarning: 1e12 }); assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(marks.length, 0, 'a refused request saves nothing');
  res = await ordered({ ordered: true, date: '2026-09-20', buyingPrice: '10.5', orderEarning: 25 });
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.order.fulfillment_status, 'ordered_from_amazon');
  assert.strictEqual(marks[0][0], 'o1'); assert.strictEqual(marks[0][1].ordered, true); assert.strictEqual(marks[0][1].date.toISOString(), '2026-09-20T12:00:00.000Z'); assert.strictEqual(marks[0][1].buyingPrice, 10.5); assert.strictEqual(marks[0][1].orderEarning, 25);
  marks.length = 0; await ordered({ ordered: true, date: '2026-09-20' }); assert.ok(marks[0][1].buyingPrice === undefined && marks[0][1].orderEarning === undefined, 'not given: the sheet figures are left alone');
  marks.length = 0; await ordered({ ordered: true, date: '2026-09-20', buyingPrice: '', orderEarning: null }); assert.ok(marks[0][1].buyingPrice === '' && marks[0][1].orderEarning === null, 'empty: clears them');
  marks.length = 0; await ordered({ ordered: true }); assert.ok(marks[0][1].date instanceof Date && Math.abs(marks[0][1].date - Date.now()) < 5000, 'no date given: today');
  marks.length = 0; res = await ordered({ ordered: false }); assert.strictEqual(res.statusCode, 200); assert.strictEqual(marks[0][1].ordered, false); assert.strictEqual(marks[0][1].date, undefined, 'Undo needs no date');
  res = await ordered({ ordered: true, date: '2026-09-20' }, 'nope'); assert.strictEqual(res.statusCode, 404);
  markResult = () => ({ error: 'shipped' }); res = await ordered({ ordered: true, date: '2026-09-20' }); assert.strictEqual(res.statusCode, 409); assert.match(res.body.error, /already shipped/);

  Module._load = origLoad;
  console.log('ebay order note route tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
