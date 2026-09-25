// eBay webhooks: the message notification endpoint answers eBay's challenge (without it the destination cannot be created at all), and a
// Marketplace Account Deletion notification removes everything ELMS keeps about that eBay user - not only the connection.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fakeRes = () => { const r = { statusCode: 200, headers: {} }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const post = (router) => router.stack.find((l) => l.route && l.route.methods.post).route.stack[0].handle;
const get = (router) => router.stack.find((l) => l.route && l.route.methods.get).route.stack[0].handle;

// ---------------- in-memory collections for the deletion service ----------------
const stores = [
  { _id: 'a1', userId: 'u1', ebayUserId: 'seller_one' },
  { _id: 'a2', userId: 'u2', ebayUserId: 'someone_else' },
];
const blank = { fullName: null, addressLine1: null, addressLine2: null, city: null, stateOrProvince: null, postalCode: null, country: null };
const address = { fullName: 'Jane Buyer', addressLine1: '1 High St', addressLine2: null, city: 'Leeds', stateOrProvince: null, postalCode: 'LS1', country: 'GB' };
const orders = [
  { _id: 'o1', buyerUsername: 'jane_buyer', buyerEmail: 'jane@x.com', buyerPhone: '0123', buyerNote: 'leave with neighbour', shippingAddress: { ...address }, salePrice: 30, sku: 'B000000001' },
  { _id: 'o2', buyerUsername: 'jane_buyer', buyerEmail: 'jane@x.com', buyerPhone: '0123', buyerNote: null, shippingAddress: { ...address }, salePrice: 12, sku: 'B000000002' },
  { _id: 'o3', buyerUsername: 'other_buyer', buyerEmail: 'other@x.com', buyerPhone: '999', buyerNote: null, shippingAddress: { ...address, fullName: 'Other Buyer' }, salePrice: 5, sku: 'B000000003' },
];
const conversations = [
  { _id: 'c1', otherPartyUsername: 'jane_buyer', fromUsername: 'jane_buyer' },
  { _id: 'c2', otherPartyUsername: 'other_buyer', fromUsername: 'other_buyer' },
  { _id: 'c3', otherPartyUsername: null, fromUsername: 'jane_buyer' },
];
const messages = [{ _id: 'm1', conversationId: 'c1' }, { _id: 'm2', conversationId: 'c2' }, { _id: 'm3', conversationId: 'c3' }, { _id: 'm4', conversationId: 'c1' }];
const inList = (v, list) => list.includes(v);
const chain = (list) => ({ select() { return this; }, lean: async () => list.map((r) => ({ ...r })) });
stub('models/schemas/EbayAccount.js', { find: (f) => chain(stores.filter((s) => inList(s.ebayUserId, f.ebayUserId.$in))) });
stub('models/schemas/Order.js', {
  updateMany: async (f, u) => { const hit = orders.filter((o) => inList(o.buyerUsername, f.buyerUsername.$in)); hit.forEach((o) => Object.assign(o, u.$set)); return { modifiedCount: hit.length }; },
});
stub('models/schemas/Conversation.js', {
  find: (f) => chain(conversations.filter((c) => f.$or.some((cond) => (cond.otherPartyUsername && inList(c.otherPartyUsername, cond.otherPartyUsername.$in)) || (cond.fromUsername && inList(c.fromUsername, cond.fromUsername.$in))))),
  deleteMany: async (f) => { for (const id of f._id.$in) conversations.splice(conversations.findIndex((c) => c._id === id), 1); },
});
stub('models/schemas/Message.js', {
  deleteMany: async (f) => { for (let i = messages.length - 1; i >= 0; i--) if (inList(messages[i].conversationId, f.conversationId.$in)) messages.splice(i, 1); },
});
const removed = [];
stub('models/ebayAccountsModel.js', {
  removeEbayAccount: async (userId, accountId) => { const i = stores.findIndex((s) => s._id === accountId && s.userId === userId); if (i < 0) return false; stores.splice(i, 1); removed.push([userId, accountId]); return true; },
});
const { deleteEbayUserData } = require('../services/ebayAccountDeletionService');

(async () => {
  // ================= the message notification endpoint answers eBay's challenge =================
  const messageRoute = require('../routes/ebayMessageNotification');
  const saved = { token: process.env.EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN, url: process.env.EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL };
  delete process.env.EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN; delete process.env.EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL;
  let res = fakeRes();
  get(messageRoute)({ query: { challenge_code: 'abc123' } }, res);
  assert.strictEqual(res.statusCode, 500, 'not set up: says what is missing');
  assert.match(res.body.error, /EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN/);
  process.env.EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN = 'a-verification-token-of-32-characters!';
  process.env.EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL = 'https://api.example.com/api/ebay/message-notification';
  res = fakeRes();
  get(messageRoute)({ query: { challenge_code: 'abc123' } }, res);
  const expected = crypto.createHash('sha256').update('abc123').update('a-verification-token-of-32-characters!').update('https://api.example.com/api/ebay/message-notification').digest('hex');
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { challengeResponse: expected }, 'SHA-256(challenge + token + endpoint), lower-case hex');
  assert.strictEqual(res.headers['Content-Type'], 'application/json');
  res = fakeRes();
  get(messageRoute)({ query: {} }, res);
  assert.strictEqual(res.statusCode, 500, 'no challenge, no answer');
  res = fakeRes();
  get(messageRoute)({ query: { challenge_code: ['a', 'b'] } }, res); // a hostile query string never crashes it
  assert.strictEqual(res.statusCode, 200);
  for (const [k, v] of [['EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN', saved.token], ['EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL', saved.url]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // ================= the deletion: a seller's store, a buyer's details =================
  assert.deepStrictEqual(await deleteEbayUserData([]), { stores: 0, orders: 0, conversations: 0 });
  assert.deepStrictEqual(await deleteEbayUserData(['', null, undefined]), { stores: 0, orders: 0, conversations: 0 });

  // a buyer: their details are erased from the orders (the sales stay), their conversations and messages are deleted
  const out = await deleteEbayUserData(['jane_buyer', 'user-id-123']);
  assert.deepStrictEqual(out, { stores: 0, orders: 2, conversations: 2 });
  for (const o of orders.slice(0, 2)) {
    assert.deepStrictEqual([o.buyerUsername, o.buyerEmail, o.buyerPhone, o.buyerNote], ['[deleted]', null, null, null]);
    assert.deepStrictEqual(o.shippingAddress, blank, 'no name or address is left');
  }
  assert.deepStrictEqual([orders[0].salePrice, orders[1].salePrice, orders[0].sku], [30, 12, 'B000000001'], 'the sale itself stays for the seller');
  assert.strictEqual(orders[2].buyerEmail, 'other@x.com', 'other buyers are untouched');
  assert.strictEqual(orders[2].shippingAddress.fullName, 'Other Buyer');
  assert.deepStrictEqual(conversations.map((c) => c._id), ['c2'], 'their conversations are gone (as buyer or as sender)');
  assert.deepStrictEqual(messages.map((m) => m._id), ['m2'], 'and their message text with them');

  // a seller: the connection AND everything stored for the store go (removeEbayAccount does the clean-up)
  const seller = await deleteEbayUserData(['seller_one']);
  assert.strictEqual(seller.stores, 1);
  assert.deepStrictEqual(removed, [['u1', 'a1']], 'through the same clean-up as disconnecting the store');
  assert.deepStrictEqual(stores.map((s) => s._id), ['a2'], 'another seller is untouched');

  // ================= the route: signature first, then the deletion =================
  const calls = [];
  let signatureOk = true;
  let serviceFails = false;
  stub('services/ebayNotificationVerifyService.js', { verifyEbaySignature: async () => signatureOk });
  stub('services/ebayAccountDeletionService.js', { deleteEbayUserData: async (ids) => { calls.push(ids); if (serviceFails) throw new Error('db down'); return { stores: 1, orders: 2, conversations: 3 }; } });
  delete process.env.EBAY_ENV; delete process.env.ELMS_TEST_MODE;
  const deletionRoute = require('../routes/ebayAccountDeletion');
  const body = (data) => Buffer.from(JSON.stringify({ notification: { data } }));
  const deliver = async (data) => { const r = fakeRes(); await post(deletionRoute)({ headers: { 'x-ebay-signature': 'sig' }, body: body(data) }, r); return r; };

  res = await deliver({ userId: 'user-id-123', username: 'jane_buyer' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls[0], ['user-id-123', 'jane_buyer'], 'the userId and the username are both passed on');
  signatureOk = false;
  res = await deliver({ username: 'jane_buyer' });
  assert.strictEqual(res.statusCode, 412, 'a forged notification deletes nothing');
  assert.strictEqual(calls.length, 1);
  signatureOk = true;
  res = await deliver({});
  assert.strictEqual(res.statusCode, 200, 'a verified notification without an identifier is acknowledged');
  assert.strictEqual(calls.length, 1);
  serviceFails = true;
  res = await deliver({ username: 'jane_buyer' });
  assert.strictEqual(res.statusCode, 500, 'a failure answers 500 so eBay sends it again');

  console.log('ebay webhooks tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
