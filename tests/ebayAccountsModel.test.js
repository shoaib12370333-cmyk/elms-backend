// The connected-account model: every account gets its "Store N" number, a store that was saved under a stand-in name (eBay gave no
// username) is taken over - not doubled - when it is connected again with its real username, and the serialized account carries
// the one name the UI shows. The database is a small in-memory stand-in; the real model code runs.
const assert = require('assert');
const Module = require('module');

const docs = [];
let seq = 0;
const makeDoc = (o) => {
  const d = {
    _id: 'acc' + (++seq), isActive: false, storeName: null, storeNumber: null, identityCheckedAt: null, displayName: null, createdAt: new Date(Date.now() + seq * 1000), ...o,
    async save() { return this; },
    toObject() { const { save, toObject, ...plain } = this; return { ...plain }; },
  };
  docs.push(d);
  return d;
};
const matches = (d, q) => Object.entries(q).every(([k, v]) => {
  if (v && typeof v === 'object' && '$ne' in v) return d[k] !== v.$ne;
  return d[k] === v;
});
const query = (list) => {
  let rows = list.slice();
  const api = {
    sort(spec) { const [[k, dir]] = Object.entries(spec); rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return api; },
    select() { return api; },
    lean() { return Promise.resolve(rows[0] ? { ...rows[0] } : null); },
    then(res, rej) { return Promise.resolve(rows).then(res, rej); },
  };
  return api;
};
const AccountModel = {
  countDocuments: async (q) => docs.filter((d) => matches(d, q)).length,
  findOne: (q) => { const found = docs.filter((d) => matches(d, q)); const api = query(found); const first = found[0] || null; api.then = (res, rej) => Promise.resolve(first).then(res, rej); const lean = api.lean; api.lean = () => lean(); return api; },
  find: (q) => query(docs.filter((d) => matches(d, q))),
  create: async (o) => makeDoc(o),
  updateOne: async (q, u) => { docs.filter((d) => matches(d, q)).forEach((d) => Object.assign(d, u)); },
  findOneAndUpdate: async (q, u) => { const d = docs.find((x) => matches(x, q)); if (d) Object.assign(d, u); return d || null; },
  updateMany: async (q, u) => { docs.filter((d) => matches(d, q)).forEach((d) => Object.assign(d, u)); },
};
const fakes = {
  './schemas/EbayAccount': AccountModel,
  './schemas/User': { findById: async () => ({ maxEbayAccounts: 5 }) },
  '../services/cryptoService': { encrypt: (x) => 'enc:' + x, decrypt: (x) => String(x).replace(/^enc:/, '') },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /ebayAccountsModel\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const model = require('../models/ebayAccountsModel');
Module._load = origLoad;

(async () => {
  // ---- the first accounts get 1, 2 ...; only the first is active ----
  let a = await model.addEbayAccount('u1', { ebayUserId: 'seller-uk', refreshToken: 't1', marketplaceId: 'EBAY_GB', storeName: 'Trendy Deals', identityCheckedAt: new Date() });
  assert.strictEqual(a.storeNumber, 1); assert.strictEqual(a.isActive, true);
  assert.strictEqual(a.label, 'Trendy Deals'); assert.strictEqual(a.username, 'seller-uk'); assert.strictEqual(a.storeName, 'Trendy Deals');
  let b = await model.addEbayAccount('u1', { ebayUserId: 'eBay Account 1758000000001', refreshToken: 't2', marketplaceId: 'EBAY_US' });
  assert.strictEqual(b.storeNumber, 2); assert.strictEqual(b.isActive, false);
  assert.strictEqual(b.label, 'Store 2', 'a stand-in name is never the label');
  assert.strictEqual(b.username, null, 'and never a username');
  assert.strictEqual(b.storeName, null, 'not looked up yet');
  assert.ok(!Object.values(b).includes('eBay Account undefined'));

  // ---- connecting the stand-in store again, now with its real username: it is the same store ----
  const before = docs.length;
  let again = await model.addEbayAccount('u1', { ebayUserId: 'plain-seller-us', refreshToken: 't2-new', marketplaceId: 'EBAY_US', storeName: '', identityCheckedAt: new Date() });
  assert.strictEqual(docs.length, before, 'no second store');
  assert.strictEqual(again.id, b.id); assert.strictEqual(again.ebayUserId, 'plain-seller-us'); assert.strictEqual(again.storeNumber, 2);
  assert.strictEqual(again.label, 'plain-seller-us', 'no eBay Store: the username');
  assert.strictEqual(again.storeName, '');
  assert.strictEqual(docs.find((d) => d._id === b.id).refreshTokenEncrypted, 'enc:t2-new', 'the new token is kept');

  // ---- two stand-in stores on one marketplace: which one is it? nobody is guessed; a new store is added ----
  await model.addEbayAccount('u1', { ebayUserId: 'eBay Account 1758000000002', refreshToken: 't3', marketplaceId: 'EBAY_AU' });
  await model.addEbayAccount('u1', { ebayUserId: 'eBay Account 1758000000003', refreshToken: 't4', marketplaceId: 'EBAY_AU' });
  const n = docs.length;
  const fresh = await model.addEbayAccount('u1', { ebayUserId: 'au-seller', refreshToken: 't5', marketplaceId: 'EBAY_AU' });
  assert.strictEqual(docs.length, n + 1, 'two candidates: a new store, not a guess');
  assert.strictEqual(fresh.storeNumber, 5);

  // ---- the same real username again: a reconnect, the store name is updated ----
  const n2 = docs.length;
  const re = await model.addEbayAccount('u1', { ebayUserId: 'seller-uk', refreshToken: 't1b', marketplaceId: 'EBAY_GB', storeName: 'Trendy Deals UK' });
  assert.strictEqual(docs.length, n2); assert.strictEqual(re.storeName, 'Trendy Deals UK'); assert.strictEqual(re.label, 'Trendy Deals UK');
  // a store name is not lost when a reconnect could not look it up
  const re2 = await model.addEbayAccount('u1', { ebayUserId: 'seller-uk', refreshToken: 't1c', marketplaceId: 'EBAY_GB' });
  assert.strictEqual(re2.storeName, 'Trendy Deals UK');

  // ---- the nickname the seller typed still wins ----
  await model.updateEbayAccountDisplayName('u1', re.id, 'UK shop');
  const list0 = await model.listEbayAccounts('u1');
  assert.strictEqual(list0.find((x) => x.id === re.id).label, 'UK shop');

  // ---- accounts connected before "Store N" existed are numbered in the order they were connected ----
  docs.length = 0; seq = 0;
  makeDoc({ userId: 'u2', ebayUserId: 'eBay Account 111', marketplaceId: 'EBAY_GB' });
  makeDoc({ userId: 'u2', ebayUserId: 'real-name', marketplaceId: 'EBAY_US', storeName: '' });
  makeDoc({ userId: 'u2', ebayUserId: 'eBay Account 333', marketplaceId: 'EBAY_AU', storeNumber: 7 });
  makeDoc({ userId: 'u3', ebayUserId: 'eBay Account 444', marketplaceId: 'EBAY_GB' });
  const list = await model.listEbayAccounts('u2');
  assert.deepStrictEqual(list.map((x) => x.label), ['Store 8', 'real-name', 'Store 7'], 'the one that had 7 keeps it; the others follow');
  assert.deepStrictEqual(list.map((x) => x.storeNumber), [8, 9, 7]);
  assert.strictEqual(docs.filter((d) => d.userId === 'u2').every((d) => d.storeNumber), true, 'the numbers were saved');
  assert.strictEqual(docs.find((d) => d.userId === 'u3').storeNumber, null, 'another user is untouched');
  // asking again changes nothing
  assert.deepStrictEqual((await model.listEbayAccounts('u2')).map((x) => x.storeNumber), [8, 9, 7]);

  console.log('ebay accounts model tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
