// A connected eBay account is shown by its real name: the seller's own nickname, else the eBay Store name, else the eBay username,
// else "Store 1", "Store 2" - never an id. The name is read from eBay (Identity API on apiz, Trading GetUser / GetStore), remembered,
// and only asked again when needed. eBay and the database are stubs; the real services run.
const assert = require('assert');
const Module = require('module');

const { accountLabel, isPlaceholderUsername, publicUsername } = require('../services/accountLabel');

// ---------------------------------------------------------------- the name shown
assert.strictEqual(accountLabel({ displayName: 'My UK shop', storeName: 'Trendy', ebayUserId: 'seller1', storeNumber: 1 }), 'My UK shop', 'the seller\'s own nickname wins');
assert.strictEqual(accountLabel({ displayName: '', storeName: 'Trendy Deals', ebayUserId: 'seller1', storeNumber: 1 }), 'Trendy Deals', 'then the eBay Store name');
assert.strictEqual(accountLabel({ storeName: '', ebayUserId: 'seller1', storeNumber: 1 }), 'seller1', 'no store: the eBay username');
assert.strictEqual(accountLabel({ storeName: '', ebayUserId: 'eBay Account 1758712345678', storeNumber: 2 }), 'Store 2', 'a stand-in id is never shown: the number is');
assert.strictEqual(accountLabel({ ebayUserId: 'eBay Account 1758712345678' }), 'eBay store');
assert.strictEqual(accountLabel(null), 'eBay store');
assert.strictEqual(accountLabel({ displayName: '  ', storeName: '  Shop  ', ebayUserId: 'x' }), 'Shop', 'spaces are trimmed');
assert.strictEqual(isPlaceholderUsername('eBay Account 1758712345678'), true);
assert.strictEqual(isPlaceholderUsername('ebay account 12'), true);
assert.strictEqual(isPlaceholderUsername('sept19deals-au'), false);
assert.strictEqual(isPlaceholderUsername(''), true);
assert.strictEqual(publicUsername('eBay Account 99'), null);
assert.strictEqual(publicUsername(' seller1 '), 'seller1');

// ---------------------------------------------------------------- reading it from eBay
const calls = [];
let getImpl; let postImpl;
const fakeAxios = { get: async (url, cfg) => { calls.push({ method: 'GET', url, headers: cfg && cfg.headers }); return getImpl(url); }, post: async (url, body, cfg) => { calls.push({ method: 'POST', url, body, headers: cfg && cfg.headers }); return postImpl(cfg.headers['X-EBAY-API-CALL-NAME'], body); } };
const fakes = { axios: fakeAxios, './ebayAuthService': { getAccessToken: async () => 'access-token' } };
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /ebayIdentityService\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const identity = require('../services/ebayIdentityService');
Module._load = origLoad;
console.warn = () => {};

const xml = (inner) => ({ data: '<?xml version="1.0"?><Response><Ack>Success</Ack>' + inner + '</Response>' });
const failure = (code, msg) => ({ data: '<Response><Ack>Failure</Ack><Errors><ShortMessage>' + msg + '</ShortMessage><ErrorCode>' + code + '</ErrorCode></Errors></Response>' });
const STORE = xml('<Store><Name>Bob&apos;s &amp; Sons Outlet</Name><URL>https://www.ebay.co.uk/str/bobs</URL><Description>x</Description><CustomCategories><CustomCategory><Name>Shoes</Name></CustomCategory></CustomCategories></Store>');
const USER = xml('<User><UserID>tradinguser</UserID><SellerInfo><StoreOwner>true</StoreOwner><StoreURL>https://www.ebay.co.uk/str/bobs</StoreURL></SellerInfo></User>');

(async () => {
  // the Identity API is on apiz, and the username comes back
  getImpl = async () => ({ data: { username: 'sept19deals-au', userId: 'opaqueId123', accountType: 'BUSINESS', businessAccount: { name: 'Deals Pty' } } });
  let u = await identity.fetchIdentityUser('rt');
  assert.strictEqual(calls[0].url, 'https://apiz.ebay.com/commerce/identity/v1/user/', 'the identity host is apiz.ebay.com');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer access-token');
  assert.strictEqual(u.username, 'sept19deals-au'); assert.strictEqual(u.businessName, 'Deals Pty');
  assert.strictEqual(await identity.fetchEbayUsername('rt'), 'sept19deals-au');
  // eBay answers some accounts with an immutable id only: that is not a name
  getImpl = async () => ({ data: { userId: 'opaqueId123' } });
  u = await identity.fetchIdentityUser('rt');
  assert.strictEqual(u.username, null); assert.strictEqual(u.userId, 'opaqueId123');
  getImpl = async () => { throw Object.assign(new Error('403'), { response: { data: { errors: [{ message: 'no scope' }] } } }); };
  assert.strictEqual(await identity.fetchEbayUsername('rt'), null, 'a failed lookup is not fatal');

  // the store name
  calls.length = 0;
  postImpl = async (name) => (name === 'GetStore' ? STORE : USER);
  let st = await identity.fetchStoreName('rt', 'EBAY_GB');
  assert.deepStrictEqual(st, { name: "Bob's & Sons Outlet", url: 'https://www.ebay.co.uk/str/bobs' }, "the store's own name, not a category's; entities decoded");
  assert.strictEqual(calls[0].headers['X-EBAY-API-CALL-NAME'], 'GetStore'); assert.strictEqual(calls[0].headers['X-EBAY-API-SITEID'], '3', 'the UK site');
  assert.strictEqual(calls[0].headers['X-EBAY-API-IAF-TOKEN'], 'access-token');
  assert.ok(/<GetStoreRequest/.test(calls[0].body));
  postImpl = async () => failure('13003', 'You do not have a Store.');
  assert.deepStrictEqual(await identity.fetchStoreName('rt', 'EBAY_US'), { name: '', url: null }, 'no store subscription = no store name (an answer, not a failure)');
  postImpl = async () => failure('931', 'Auth token is hard expired.');
  assert.strictEqual(await identity.fetchStoreName('rt', 'EBAY_US'), null, 'a real failure = unknown');
  postImpl = async () => { throw new Error('network'); };
  assert.strictEqual(await identity.fetchStoreName('rt', 'EBAY_US'), null);
  assert.deepStrictEqual(identity.parseTradingUser(USER.data), { username: 'tradinguser', hasStore: true, storeUrl: 'https://www.ebay.co.uk/str/bobs' });
  assert.deepStrictEqual(identity.parseStore('<Response></Response>'), { name: null, url: null });

  // everything together
  getImpl = async () => ({ data: { username: 'seller-uk' } });
  postImpl = async (name) => (name === 'GetStore' ? STORE : USER);
  let all = await identity.fetchSellerIdentity('rt', 'EBAY_GB');
  assert.strictEqual(all.username, 'seller-uk'); assert.strictEqual(all.storeName, "Bob's & Sons Outlet"); assert.strictEqual(all.hasStore, true); assert.strictEqual(all.checked, true);
  // no username from the Identity API: GetUser gives it
  getImpl = async () => ({ data: { userId: 'opaque' } });
  all = await identity.fetchSellerIdentity('rt', 'EBAY_GB');
  assert.strictEqual(all.username, 'tradinguser');
  // the Identity API is down: the Trading API still names the account
  getImpl = async () => { throw new Error('down'); };
  all = await identity.fetchSellerIdentity('rt', 'EBAY_GB');
  assert.strictEqual(all.username, 'tradinguser'); assert.strictEqual(all.storeName, "Bob's & Sons Outlet"); assert.strictEqual(all.checked, true);
  // a seller without a store
  postImpl = async (name) => (name === 'GetStore' ? failure('13003', 'no store') : xml('<User><UserID>plain</UserID><SellerInfo><StoreOwner>false</StoreOwner></SellerInfo></User>'));
  getImpl = async () => ({ data: { username: 'plain' } });
  all = await identity.fetchSellerIdentity('rt', 'EBAY_US');
  assert.strictEqual(all.storeName, ''); assert.strictEqual(all.hasStore, false); assert.strictEqual(all.username, 'plain');
  // nothing answers
  getImpl = async () => { throw new Error('down'); }; postImpl = async () => { throw new Error('down'); };
  all = await identity.fetchSellerIdentity('rt', 'EBAY_US');
  assert.strictEqual(all.username, null); assert.strictEqual(all.storeName, null); assert.strictEqual(all.checked, false);

  // ---------------------------------------------------------------- remembering it (database stubbed)
  const docs = [];
  const AccountModel = {
    findOne: async (q) => docs.find((d) => String(d._id) === String(q._id) && String(d.userId) === String(q.userId)) || null,
    exists: async (q) => docs.some((d) => d.userId === q.userId && d.ebayUserId === q.ebayUserId && String(d._id) !== String(q._id.$ne)),
    findOneAndUpdate: async (q, update) => { const d = docs.find((x) => String(x._id) === String(q._id)); Object.assign(d, update); return d; },
  };
  let lookups = 0; let lookupImpl;
  const fakes2 = {
    '../models/schemas/EbayAccount': AccountModel,
    './cryptoService': { decrypt: (x) => 'token-of-' + x },
    './ebayIdentityService': { fetchSellerIdentity: async (token, marketplace) => { lookups += 1; return lookupImpl(token, marketplace); } },
  };
  Module._load = function (request, parent) {
    if (fakes2[request] && parent && /accountIdentityService\.js$/.test(parent.filename)) return fakes2[request];
    return origLoad.apply(this, arguments);
  };
  const svc = require('../services/accountIdentityService');
  Module._load = origLoad;

  const now = Date.now(); const H = 3600 * 1000;
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: null, storeName: 'X', ebayUserId: 'u' }, now), true, 'never asked');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 2 * H), storeName: 'X', ebayUserId: 'u' }, now), false, 'known and recent');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 8 * 24 * H), storeName: 'X', ebayUserId: 'u' }, now), true, 'known but a week old');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 2 * H), storeName: null, ebayUserId: 'u' }, now), false, 'unknown but asked 2 hours ago');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 7 * H), storeName: null, ebayUserId: 'u' }, now), true, 'unknown: asked again after 6 hours');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 7 * H), storeName: '', ebayUserId: 'eBay Account 123' }, now), true, 'a stand-in name keeps being retried');
  assert.strictEqual(svc.needsIdentity({ identityCheckedAt: new Date(now - 7 * H), storeName: '', ebayUserId: 'real' }, now), false, 'no store, real username: fine');

  // the answer is saved: store name, and the real username in place of the stand-in
  docs.push({ _id: 'a1', userId: 'u1', ebayUserId: 'eBay Account 1758', marketplaceId: 'EBAY_GB', refreshTokenEncrypted: 'enc1', storeName: null, identityCheckedAt: null });
  lookupImpl = async () => ({ username: 'seller-uk', storeName: 'Trendy Deals UK', checked: true });
  let saved = await svc.refreshAccountIdentity('u1', 'a1');
  assert.strictEqual(saved.storeName, 'Trendy Deals UK'); assert.strictEqual(saved.ebayUserId, 'seller-uk'); assert.ok(saved.identityCheckedAt instanceof Date);
  // the same username already belongs to another account of the user: the stand-in stays
  docs.push({ _id: 'a2', userId: 'u1', ebayUserId: 'eBay Account 999', marketplaceId: 'EBAY_US', refreshTokenEncrypted: 'enc2', storeName: null, identityCheckedAt: null });
  saved = await svc.refreshAccountIdentity('u1', 'a2');
  assert.strictEqual(saved.ebayUserId, 'eBay Account 999', 'the username is already another account of this user: the stand-in stays (no duplicate key)');
  assert.strictEqual(saved.storeName, 'Trendy Deals UK', 'the store name is still saved');
  // a lookup that fails only postpones the next one
  docs.push({ _id: 'a3', userId: 'u1', ebayUserId: 'eBay Account 555', marketplaceId: 'EBAY_AU', refreshTokenEncrypted: 'enc3', storeName: null, identityCheckedAt: null });
  lookupImpl = async () => { throw new Error('eBay down'); };
  saved = await svc.refreshAccountIdentity('u1', 'a3');
  assert.ok(saved.identityCheckedAt instanceof Date); assert.strictEqual(saved.storeName, null); assert.strictEqual(saved.ebayUserId, 'eBay Account 555');
  // "no store" is remembered as '' (not asked again for a week)
  docs.push({ _id: 'a4', userId: 'u1', ebayUserId: 'plainseller', marketplaceId: 'EBAY_UK', refreshTokenEncrypted: 'enc4', storeName: null, identityCheckedAt: null });
  lookupImpl = async () => ({ username: 'plainseller', storeName: '', checked: true });
  saved = await svc.refreshAccountIdentity('u1', 'a4');
  assert.strictEqual(saved.storeName, '');
  assert.strictEqual(svc.needsIdentity(saved), false);
  // an unknown account
  assert.strictEqual(await svc.refreshAccountIdentity('u1', 'nope'), null);
  // two page loads at once ask eBay once
  docs.push({ _id: 'a5', userId: 'u1', ebayUserId: 'x5', marketplaceId: 'EBAY_US', refreshTokenEncrypted: 'enc5', storeName: null, identityCheckedAt: null });
  lookups = 0; lookupImpl = async () => { await new Promise((r) => setTimeout(r, 30)); return { username: 'x5', storeName: 'Five', checked: true }; };
  await Promise.all([svc.refreshAccountIdentity('u1', 'a5'), svc.refreshAccountIdentity('u1', 'a5')]);
  assert.strictEqual(lookups, 1);
  // only the accounts that need it are asked, and the page never waits longer than the cap
  lookups = 0;
  const fresh = { id: 'f', identityCheckedAt: new Date(), storeName: 'Ok', ebayUserId: 'ok' };
  const stale = { id: 'a5', identityCheckedAt: null, storeName: null, ebayUserId: 'x5' };
  assert.deepStrictEqual(await svc.refreshStaleIdentities('u1', [fresh, stale]), ['a5']);
  assert.strictEqual(lookups, 1);
  assert.deepStrictEqual(await svc.refreshStaleIdentities('u1', [fresh]), []);
  lookupImpl = async () => { await new Promise((r) => setTimeout(r, 400)); return { username: 'x5', storeName: 'Slow', checked: true }; };
  const t0 = Date.now();
  await svc.refreshStaleIdentities('u1', [{ id: 'a5', identityCheckedAt: null, storeName: null, ebayUserId: 'x5' }], { timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 300, 'the request did not wait for a slow eBay');

  console.log('account identity tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
