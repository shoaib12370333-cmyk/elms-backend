// Loading: the API's answers are gzipped, a list of listings is read as plain objects with only what it needs (not each listing's whole Amazon
// import, not eBay's publish answer, not the store's tokens), an order reads only what it shows, and the dashboard gets its order totals from one
// small answer. The real code runs; the database is a stand-in.
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const Module = require('module');
const express = require('express');

const idOf = (s) => ({ toString: () => s });

(async () => {
  // ---------- gzip ----------
  const compress = require('../middleware/compression');
  const app = express();
  app.use(compress);
  const big = { items: Array.from({ length: 600 }, (_, i) => ({ id: i, title: 'Product number ' + i + ' ' + 'x'.repeat(60), price: 10 + i })) };
  app.get('/big', (req, res) => res.json(big));
  app.get('/small', (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject);
  });
  const plain = await get('/big', { 'Accept-Encoding': 'identity' });
  const zipped = await get('/big', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(zipped.headers['content-encoding'], 'gzip'); assert.strictEqual(plain.headers['content-encoding'], undefined);
  assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(zipped.body).toString()), big, 'the same answer once unzipped');
  assert.ok(zipped.body.length < plain.body.length / 4, 'a big list is a fraction of its size: ' + zipped.body.length + ' vs ' + plain.body.length);
  assert.strictEqual((await get('/small', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined, 'a small answer is sent as it is');
  assert.strictEqual((await get('/big', { 'Accept-Encoding': 'gzip', 'x-no-compression': '1' })).headers['content-encoding'], undefined, 'a request can opt out');
  server.close();

  // ---------- a list of listings ----------
  const seen = { select: null, populates: [], sort: null, lean: false, query: null };
  const plainListing = {
    _id: idOf('l1'), userId: idOf('u1'), importId: { _id: idOf('i1'), asin: 'B0AAAA1111', amazonUrl: 'https://www.amazon.co.uk/dp/B0AAAA1111', amazonPrice: 12, product: { price: 12, brand: 'Acme', description: 'Long text', images: ['https://m.media-amazon.com/images/I/A.jpg'], variants: [{ asin: 'B0AAAA1111', title: 'Red', isCurrentProduct: true }, { asin: 'B0BBBB2222', title: 'Blue' }] } },
    ebayAccountId: { _id: idOf('a1'), displayName: 'Trendy UK', ebayUserId: 'trendy_uk' }, sku: 'B0AAAA1111', title: 'Kettle', status: 'published', amazonPrice: null, sellPrice: 20, quantity: 1, images: [], description: '', tags: [],
  };
  const fakes = {
    './schemas/Listing': { find: (q) => { seen.query = q; const c = { select: (s) => { seen.select = s; return c; }, populate: (p) => { seen.populates.push(p); return c; }, sort: (s) => { seen.sort = s; return c; }, lean: async () => { seen.lean = true; return [plainListing]; } }; return c; } },
    './schemas/Order': { aggregate: async () => [{ _id: 'l1', sold: 3 }] },
    './schemas/EbayAccount': { find: () => ({ select: () => ({ lean: async () => [] }) }) },
    '../services/skuService': { normalizeAsinSku: (s) => s, requireAsinSku: (s) => s },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /listingsModel\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const L = require('../models/listingsModel');
  const rows = await L.listListings('a1b2c3d4e5f6a7b8c9d0e1f2', 'published', null); // the stand-ins stay in place: the sold count reads the orders inside
  Module._load = orig;
  assert.strictEqual(seen.lean, true, 'plain objects, not database documents');
  assert.strictEqual(seen.select, '-publishResponse -publishErrorDetails', "eBay's publish answer is not sent with every row");
  const imp = seen.populates.find((p) => p.path === 'importId'); const acc = seen.populates.find((p) => p.path === 'ebayAccountId');
  assert.ok(imp && /product\.price/.test(imp.select) && /product\.variants/.test(imp.select) && !/aplusContent|productInformation|categories/.test(imp.select), 'the import: what the list uses, not its A+ content or product information');
  assert.ok(acc && /displayName/.test(acc.select) && !/token|secret/i.test(acc.select), "the store: its name only, never its tokens");
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.deepStrictEqual([r.id, r.amazon_url, r.amazon_price, r.asin, r.ebay_account_label, r.sold_count, r.supplier_country], ['l1', 'https://www.amazon.co.uk/dp/B0AAAA1111', 12, 'B0AAAA1111', 'Trendy UK', 3, 'UK'], 'the same row as before');
  assert.strictEqual(r.brand, 'Acme'); assert.strictEqual(r.description, 'Long text', 'a listing without a description of its own still shows the import\'s'); assert.deepStrictEqual(r.images, ['https://m.media-amazon.com/images/I/A.jpg']);
  assert.deepStrictEqual(r.variants.map((v) => v.asin), ['B0AAAA1111'], 'only the product itself');
  assert.strictEqual(r.publish_response, null);

  // ---------- the dashboard's order totals ----------
  const finds = [];
  const orderSeen = { select: null, populate: null };
  const doc = (id, o = {}) => ({ _id: idOf(id), userId: idOf('u1'), ebayOrderId: '11-' + id, sku: 'B0' + id, quantity: 1, currency: 'GBP', salePrice: 100, listingId: { title: 'L' + id, sku: 'B0' + id, amazonPrice: 60, importId: null }, ...o });
  const orders = [
    doc('o1', { salePrice: 150, listingId: { title: 'A', sku: 'B01', amazonPrice: 100 } }),
    doc('o2', { salePrice: 0.3, listingId: { title: 'B', sku: 'B02', amazonPrice: 0.1 } }),
    doc('o3', { currency: 'EUR', salePrice: 50, buyPriceOverride: 20 }),
    doc('o4', { salePrice: 999, ebayCancelStatus: 'CANCELED' }),
    doc('o5', { salePrice: 10, listingId: { title: 'E', sku: 'B05', amazonPrice: null, importId: null } }),
  ];
  const orderFakes = {
    './schemas/Order': { find: (q) => { finds.push(q); const c = { select: (s) => { orderSeen.select = s; return c; }, populate: (p) => { orderSeen.populate = p; return c; }, lean: async () => orders }; return c; } },
    './schemas/Listing': {}, './schemas/Import': {},
    './schemas/EbayAccount': { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  };
  Module._load = function (request, parent) { if (orderFakes[request] && parent && /ordersModel\.js$/.test(parent.filename)) return orderFakes[request]; return orig.apply(this, arguments); };
  delete require.cache[require.resolve('../models/ordersModel')];
  const O = require('../models/ordersModel');
  Module._load = orig;
  const s1 = await O.ordersSummary('u1');
  assert.strictEqual(s1.orders, 5, 'every order is counted');
  assert.deepStrictEqual(s1.currencies, [
    { currency: 'GBP', orders: 3, revenue: 160.3, profit: 50.2, profit_orders: 2 },
    { currency: 'EUR', orders: 1, revenue: 50, profit: 30, profit_orders: 1 },
  ], 'per currency, exact cents, the cancelled order is left out, an order with no cost has revenue but no profit');
  assert.ok(/ebayCancelStatus/.test(orderSeen.select) && /salePrice/.test(orderSeen.select) && !/shippingAddress|buyerEmail|itemImage/.test(orderSeen.select), 'only the fields the totals need');
  assert.strictEqual(orderSeen.populate.path, 'listingId'); assert.ok(!/aplusContent|productInformation/.test(orderSeen.populate.populate.select), 'not the whole import');
  await O.ordersSummary('u1'); assert.strictEqual(finds.length, 1, 'kept for a minute: a second look does not read again');
  O._summaryCache.clear(); await O.ordersSummary('u1', 'a'.repeat(24)); assert.strictEqual(finds.length, 2); assert.deepStrictEqual([finds[1].userId, String(finds[1].ebayAccountId)], ['u1', 'a'.repeat(24)], 'one store when asked');
  O._summaryCache.clear();
  orders.length = 0; assert.deepStrictEqual(await O.ordersSummary('u1'), { orders: 0, currencies: [] });

  console.log('faster loading tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
