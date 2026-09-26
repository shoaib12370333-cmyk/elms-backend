// The database side of the Net Profit sheet: which orders a request reads (cancelled ones left out unless asked, store, dates, a safe search),
// newest first, and in slices for "Add lines". The real model runs with the database stood in.
const assert = require('assert');
const Module = require('module');

const seen = { find: null, sort: null, skip: null, limit: null, count: null, populates: [] };
let docs = [];
const listings = [{ _id: 'L1' }, { _id: 'L2' }];
const fakes = {
  './schemas/Order': {
    countDocuments: async (q) => { seen.count = q; return 7; },
    find: (q) => {
      seen.find = q;
      const chain = { populate: (p) => { seen.populates.push(typeof p === 'string' ? p : p.path); return chain; }, sort: (s) => { seen.sort = s; return chain; }, skip: (n) => { seen.skip = n; return chain; }, limit: (n) => { seen.limit = n; return chain; }, lean: async () => docs };
      return chain;
    },
  },
  './schemas/Listing': { find: (q) => ({ select: () => ({ limit: () => ({ lean: async () => { seen.listingQuery = q; return listings; } }) }), populate: () => ({ lean: async () => [] }) }) },
  './schemas/Import': {},
};
const orig = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /ordersModel\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
const M = require('../models/ordersModel');
Module._load = orig;

const doc = (id, extra = {}) => ({ _id: { toString: () => id }, userId: { toString: () => 'u1' }, ebayOrderId: '11-' + id, sku: 'B0' + id, quantity: 1, salePrice: 150, currency: 'GBP', itemTitle: 'Item ' + id,
  listingId: { title: 'Listing ' + id, sku: 'B0' + id, amazonPrice: 100, importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0' + id } }, ...extra });

(async () => {
  // ---------- the filter ----------
  let q = await M.netProfitQuery('u1', {});
  assert.deepStrictEqual(q, { userId: 'u1', ebayCancelStatus: { $nin: ['CANCELED', 'CANCELLED'] } }, 'cancelled orders are left out by default');
  q = await M.netProfitQuery('u1', { includeCancelled: true }); assert.ok(!('ebayCancelStatus' in q));
  q = await M.netProfitQuery('u1', { accountId: 'A1' }); assert.strictEqual(q.ebayAccountId, 'A1');
  const from = new Date('2026-09-01T00:00:00Z'); const to = new Date('2026-09-30T23:59:59Z');
  q = await M.netProfitQuery('u1', { from, to });
  assert.deepStrictEqual(q.$and[0].$or[0], { ebayCreatedAt: { $gte: from, $lte: to } }); assert.deepStrictEqual(q.$and[0].$or[1], { ebayCreatedAt: null, createdAt: { $gte: from, $lte: to } }, 'an order without eBay\'s date uses the date ELMS saved it');
  q = await M.netProfitQuery('u1', { from }); assert.deepStrictEqual(q.$and[0].$or[0].ebayCreatedAt, { $gte: from });
  // the search: title of the listing, eBay title, order ID, SKU, item number; the text is never read as a pattern
  q = await M.netProfitQuery('u1', { q: 'a.b(c)' });
  const or = q.$and[0].$or; const re = or[0].itemTitle;
  assert.ok(re.test('xx A.B(C) yy')); assert.ok(!re.test('aXb(c)'), 'a dot in the search is a dot, not "any letter"');
  assert.deepStrictEqual(Object.keys(or.map((o) => Object.keys(o)[0]).reduce((a, k) => ({ ...a, [k]: 1 }), {})), ['itemTitle', 'ebayOrderId', 'sku', 'legacyItemId', 'listingId']);
  assert.deepStrictEqual(or[4].listingId.$in, ['L1', 'L2'], 'orders of the listings whose title matches'); assert.ok(seen.listingQuery.title.test('A.B(C)') && seen.listingQuery.userId === 'u1');
  await assert.doesNotReject(() => M.netProfitQuery('u1', { q: '((([[[***' }), 'a broken pattern is only text');
  assert.strictEqual((await M.netProfitQuery('u1', { q: '   ' })).$and, undefined, 'an empty search filters nothing');
  assert.strictEqual(await M.countNetProfitLines('u1', { q: '' }), 7);

  // ---------- the lines: newest first, sliced, with the money worked out ----------
  docs = [doc('a', { netProfit: 30 }), doc('b', { salePrice: 0.3, listingId: { title: 'Cheap', sku: 'B0b', amazonPrice: 0.1, importId: null } }), doc('c', { itemTitle: 'From eBay', listingId: null, currency: 'EUR', salePrice: 20 })];
  const lines = await M.listNetProfitLines('u1', {}, { offset: 2000, limit: 1000 });
  assert.deepStrictEqual([seen.skip, seen.limit], [2000, 1000]); assert.deepStrictEqual(seen.sort, { ebayCreatedAt: -1, createdAt: -1, _id: -1 }, 'newest first, and a stable order so "Add lines" never repeats or skips one');
  assert.ok(seen.populates.includes('listingId') && seen.populates.includes('ebayAccountId'));
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual([lines[0].title, lines[0].amazon_price, lines[0].ebay_price, lines[0].profit, lines[0].net_profit, lines[0].ebay_cost], ['Listing a', 100, 150, 50, 30, 20]);
  assert.strictEqual(lines[0].amazon_url, 'https://www.amazon.co.uk/dp/B0a');
  assert.deepStrictEqual([lines[1].profit, lines[1].ebay_cost], [0.2, null], 'exact cents, eBay cost empty without a net profit');
  assert.deepStrictEqual([lines[2].title, lines[2].amazon_price, lines[2].profit, lines[2].currency], ['From eBay', null, null, 'EUR'], 'an order with no listing: eBay\'s title, no Amazon price to invent');

  console.log('net profit query tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
