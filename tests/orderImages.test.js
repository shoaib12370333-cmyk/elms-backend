// eBay's order data has no pictures: they are read from the items (GetItem), once per item, and a re-sync keeps them.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const orders = [];
const matches = (o, f) => Object.entries(f).every(([k, v]) => {
  if (k === '$or') return v.some((c) => matches(o, c));
  if (v && typeof v === 'object' && '$ne' in v) return o[k] !== v.$ne;
  if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(o[k]);
  if (v && typeof v === 'object' && '$lt' in v) return o[k] != null && o[k] < v.$lt;
  return (o[k] === undefined ? null : o[k]) === v;
});
stub('models/schemas/Order', {
  find: (f) => { const rows = orders.filter((o) => matches(o, f)); const q = { select: () => q, limit: () => q, lean: async () => rows }; return q; },
  updateMany: async (f, u) => { orders.filter((o) => matches(o, f)).forEach((o) => Object.assign(o, u.$set)); },
});
stub('models/ebayAccountsModel', { listEbayAccounts: async () => [{ id: 'a1' }], getEbayAccountRefreshToken: async () => 'tok' });
stub('services/ebayAuthService', { getAccessToken: async () => 'access' });

const axios = require('axios');
const asked = [];
let answers = {};
axios.post = async (url, body) => {
  const id = /<ItemID>(\d+)<\/ItemID>/.exec(body)[1];
  asked.push(id);
  if (answers[id] === 'boom') throw new Error('timeout');
  return { data: answers[id] || '<GetItemResponse><Ack>Success</Ack><Item><PictureDetails></PictureDetails></Item></GetItemResponse>' };
};
const svc = require('../services/orderImageService');

const pic = (u) => `<GetItemResponse><Ack>Success</Ack><Item><PictureDetails><PictureURL>${u}</PictureURL><PictureURL>https://i.ebayimg.com/second.jpg</PictureURL></PictureDetails></Item></GetItemResponse>`;

(async () => {
  assert.strictEqual(svc.parseItemImage(pic('http://i.ebayimg.com/00/s/x.jpg?a=1&amp;b=2')), 'https://i.ebayimg.com/00/s/x.jpg?a=1&b=2', 'first picture, https, entities decoded');
  assert.strictEqual(svc.parseItemImage('<Ack>Failure</Ack>'), null);

  // three orders for two items, one order already has a picture, one item has none on eBay, one call fails
  orders.push(
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '111', marketplaceId: 'EBAY_US', itemImage: null },
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '111', marketplaceId: 'EBAY_US', itemImage: null },
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '222', marketplaceId: 'EBAY_US', itemImage: null },
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '333', marketplaceId: 'EBAY_US', itemImage: null },
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '444', marketplaceId: 'EBAY_US', itemImage: 'https://already.jpg' },
    { userId: 'u1', ebayAccountId: 'a1', legacyItemId: null, itemImage: null },
    { userId: 'u2', ebayAccountId: 'a9', legacyItemId: '111', itemImage: null },
  );
  answers = { 111: pic('https://i.ebayimg.com/one.jpg'), 222: 'boom' };
  const filled = await svc.fillMissingOrderImages('u1', 'a1', 'tok');
  assert.strictEqual(filled, 1);
  assert.deepStrictEqual(asked.sort(), ['111', '222', '333'], 'one call per item, none for orders that have a picture or no item number');
  assert.deepStrictEqual(orders.slice(0, 2).map((o) => o.itemImage), ['https://i.ebayimg.com/one.jpg', 'https://i.ebayimg.com/one.jpg'], 'every order of that item gets it');
  assert.strictEqual(orders[4].itemImage, 'https://already.jpg');
  assert.strictEqual(orders[6].itemImage, null, 'another seller\'s order is untouched');

  // a second run does not ask again about items eBay had nothing for (or that failed) ...
  asked.length = 0;
  assert.strictEqual(await svc.fillMissingOrderImages('u1', 'a1', 'tok'), 0);
  assert.deepStrictEqual(asked, [], 'asked recently: not again');
  // ... unless it is forced (a single order was refreshed by hand), and only for the items named
  answers = { 222: pic('https://i.ebayimg.com/two.jpg') };
  assert.strictEqual(await svc.fillMissingOrderImages('u1', 'a1', 'tok', { legacyItemIds: ['222'], force: true }), 1);
  assert.deepStrictEqual(asked, ['222']);
  assert.strictEqual(orders[2].itemImage, 'https://i.ebayimg.com/two.jpg');

  // after a week it is asked again
  orders[3].itemImageCheckedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  asked.length = 0; answers = { 333: pic('https://i.ebayimg.com/three.jpg') };
  assert.strictEqual(await svc.fillMissingOrderImages('u1', 'a1', 'tok'), 1);
  assert.deepStrictEqual(asked, ['333']);

  // the per-run limit
  for (let i = 0; i < 10; i++) orders.push({ userId: 'u1', ebayAccountId: 'a1', legacyItemId: String(900 + i), itemImage: null });
  asked.length = 0; answers = {};
  await svc.fillMissingOrderImages('u1', 'a1', 'tok', { limit: 4 });
  assert.strictEqual(asked.length, 4);
  console.log('order images tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
