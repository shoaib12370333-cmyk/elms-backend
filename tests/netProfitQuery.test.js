// The database side of the Net Profit sheet: which orders a request reads (cancelled ones left out unless asked, store, dates, a safe search),
// newest first, and in slices for "Add lines". The real model runs with the database stood in.
const assert = require('assert');
const Module = require('module');

const seen = { find: null, sort: null, skip: null, limit: null, count: null, populates: [] };
let docs = [];
const listings = [{ _id: 'L1' }, { _id: 'L2' }];
let distinctData = { sku: ['B0a', 'EBAY-1', '', null, 'B0b'], ebayListingId: ['110001', 110002] };
let aggRows = [];
const distinctCalls = [];
const fakes = {
  './schemas/Order': {
    countDocuments: async (q) => { seen.count = q; return 7; },
    aggregate: async (pipeline) => { seen.pipeline = pipeline; return aggRows; },
    find: (q) => {
      seen.find = q;
      const chain = { populate: (p) => { seen.populates.push(typeof p === 'string' ? p : p.path); return chain; }, sort: (s) => { seen.sort = s; return chain; }, skip: (n) => { seen.skip = n; return chain; }, limit: (n) => { seen.limit = n; return chain; }, lean: async () => docs };
      return chain;
    },
  },
  './schemas/Listing': { distinct: async (field, q) => { distinctCalls.push([field, q]); return distinctData[field] || []; }, find: (q) => { const picked = { limit: () => ({ lean: async () => { seen.listingQuery = q; return listings; } }), populate: () => ({ lean: async () => [] }) }; return { select: () => picked, populate: () => ({ lean: async () => [] }) }; } },
  './schemas/Import': {},
  './schemas/EbayAccount': { find: () => ({ select: () => ({ lean: async () => [] }) }) },
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
  assert.deepStrictEqual(q.ebayCancelStatus, { $nin: ['CANCELED', 'CANCELLED'] }, 'cancelled orders are left out by default'); assert.strictEqual(q.userId, 'u1');
  // only orders of products listed WITH ELMS: linked to a listing, or with the SKU / item number of one of the seller's ELMS listings (never eBay's own "EBAY-" placeholder SKU)
  assert.deepStrictEqual(q.$and, [{ $or: [{ listingId: { $ne: null } }, { sku: { $in: ['B0a', 'B0b'] } }, { legacyItemId: { $in: ['110001', '110002'] } }] }]);
  assert.deepStrictEqual(distinctCalls[0], ['sku', { userId: 'u1', status: { $nin: ['draft', 'error'] } }], 'a draft is not a listing that sold anything'); assert.deepStrictEqual(distinctCalls[1][0], 'ebayListingId');
  distinctData = { sku: [], ebayListingId: [] }; assert.deepStrictEqual((await M.netProfitQuery('u1', {})).$and, [{ $or: [{ listingId: { $ne: null } }] }], 'no ELMS listings: only orders already linked to one'); distinctData = { sku: ['B0a', 'EBAY-1', '', null, 'B0b'], ebayListingId: ['110001', 110002] };
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
  assert.strictEqual((await M.netProfitQuery('u1', { q: '   ' })).$and.length, 1, 'an empty search filters nothing (only the ELMS-orders condition is there)');
  assert.strictEqual(await M.countNetProfitLines('u1', { q: '' }), 7);

  // ---------- the lines: newest first, sliced, with the money worked out ----------
  docs = [doc('a', { sheetAmazonPrice: 100, orderEarning: 130 }), doc('b', { salePrice: 0.3, sheetAmazonPrice: 0.1, listingId: { title: 'Cheap', sku: 'B0b', amazonPrice: 0.1, importId: null } }), doc('c', { itemTitle: 'From eBay', listingId: null, currency: 'EUR', salePrice: 20 }), doc('d', { netProfit: 12 })];
  const lines = await M.listNetProfitLines('u1', {}, { offset: 2000, limit: 1000 });
  assert.deepStrictEqual([seen.skip, seen.limit], [2000, 1000]); assert.deepStrictEqual(seen.sort, { ebayCreatedAt: -1, createdAt: -1, _id: -1 }, 'newest first, and a stable order so "Add lines" never repeats or skips one');
  assert.ok(seen.populates.includes('listingId') && seen.populates.includes('ebayAccountId'));
  assert.strictEqual(lines.length, 4);
  assert.deepStrictEqual([lines[0].title, lines[0].amazon_price, lines[0].ebay_price, lines[0].profit, lines[0].order_earning, lines[0].ebay_cost, lines[0].net_profit], ['Listing a', 100, 150, 50, 130, 20, 30], 'the typed Amazon price and order earning; eBay cost and net profit worked out');
  assert.strictEqual(lines[0].amazon_url, 'https://www.amazon.co.uk/dp/B0a');
  assert.deepStrictEqual([lines[1].profit, lines[1].ebay_cost, lines[1].net_profit], [0.2, null, null], 'exact cents; without the order earning there is no eBay cost and no net profit');
  assert.deepStrictEqual([lines[2].title, lines[2].amazon_price, lines[2].profit, lines[2].currency], ['From eBay', null, null, 'EUR'], "an order with no listing: eBay's title, no Amazon price to invent");
  assert.strictEqual(lines[3].amazon_price, null, 'the Amazon price is never taken from the listing (it is 60 on the listing, and the sheet leaves it empty)');
  assert.deepStrictEqual([lines[3].net_profit, lines[3].net_profit_older], [12, true], 'a net profit typed in the first version of the sheet is still shown');

  // ---------- the dashboard sum: the net profit (order earning - Amazon price; else the older typed figure), per currency, over the same (ELMS) orders; exact cents ----------
  const mongoose = require('mongoose');
  const uid = 'a1b2c3d4e5f6a7b8c9d0e1f2'; const acc = '0123456789abcdef01234567';
  aggRows = [{ _id: 'gbp', sum: 12500.000000001, count: 2 }, { _id: 'EUR', sum: -350.00000002, count: 5 }, { _id: null, sum: 100, count: 1 }];
  const sum = await M.netProfitSummary(uid, { accountId: acc, includeCancelled: false });
  const match = seen.pipeline[0].$match;
  assert.ok(match.userId instanceof mongoose.Types.ObjectId && String(match.userId) === uid, 'the aggregation needs real ids'); assert.ok(match.ebayAccountId instanceof mongoose.Types.ObjectId);
  assert.ok(match.$and && match.ebayCancelStatus, 'the same ELMS-only / not cancelled filter as the sheet'); assert.ok(!('netProfit' in match), 'the filter no longer needs a typed net profit: it is worked out below');
  assert.strictEqual(JSON.stringify(seen.pipeline[1].$addFields._net), JSON.stringify({ $cond: [{ $and: [{ $ne: [{ $ifNull: ['$orderEarning', null] }, null] }, { $ne: [{ $ifNull: ['$sheetAmazonPrice', null] }, null] }] }, { $subtract: ['$orderEarning', '$sheetAmazonPrice'] }, { $ifNull: ['$netProfit', null] }] }), 'earning - Amazon price when both are typed, else the older figure');
  assert.deepStrictEqual(seen.pipeline[2], { $match: { _net: { $ne: null } } }, 'only orders that have a net profit');
  assert.deepStrictEqual(seen.pipeline[3], { $group: { _id: '$currency', sum: { $sum: { $round: [{ $multiply: ['$_net', 100] }, 0] } }, count: { $sum: 1 } } }, 'whole cents per order, added up');
  assert.deepStrictEqual(sum.currencies, [{ currency: 'EUR', net_profit: -3.5, orders: 5 }, { currency: 'GBP', net_profit: 125, orders: 2 }, { currency: null, net_profit: 1, orders: 1 }], 'per currency, rounded to the cent, most orders first');
  assert.strictEqual(sum.orders, 8); assert.strictEqual(sum.ordersTotal, 7);
  aggRows = []; assert.deepStrictEqual(await M.netProfitSummary(uid, {}), { currencies: [], orders: 0, ordersTotal: 7 });

  console.log('net profit query tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
