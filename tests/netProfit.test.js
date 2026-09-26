// The Net Profit sheet: the money is worked out in whole cents (so the numbers are exact), EBAY COST is PROFIT - NET PROFIT and stays empty
// until NET PROFIT is typed, currencies are never mixed, a free account reaches only its lines, and the CSV has every column.
const assert = require('assert');
const Module = require('module');
const S = require('../services/netProfitService');

const order = (over = {}) => ({ id: 'o1', listing_title: 'CarPlan All Seasons Windscreen Wash', ebay_order_id: '11-12345-67890', legacy_item_id: '110001234567', asin: 'B0ABC12345', quantity: 1, sale_price: 150, buy_price: 100, currency: 'GBP', ebay_account_label: 'Trendy UK', ebay_created_at: '2026-09-20T10:00:00Z', order_status: 'shipped', ...over });

(async () => {
  // ---------- cents: exact, half away from zero ----------
  assert.strictEqual(S.cents(0.1 + 0.2), 30); assert.strictEqual(S.cents(1.005), 101); assert.strictEqual(S.cents(-1.005), -101); assert.strictEqual(S.cents('19.99'), 1999);
  assert.strictEqual(S.cents(null), null); assert.strictEqual(S.cents(''), null); assert.strictEqual(S.cents('abc'), null); assert.strictEqual(S.cents(0), 0);
  assert.strictEqual(S.money(1999), 19.99); assert.strictEqual(S.money(null), null);

  // ---------- the seller's own example: 100 + 150 -> profit 50; net profit 30 -> eBay cost 20 ----------
  let l = S.buildLine(order());
  assert.strictEqual(l.amazon_price, 100); assert.strictEqual(l.ebay_price, 150); assert.strictEqual(l.profit, 50);
  assert.strictEqual(l.net_profit, null); assert.strictEqual(l.ebay_cost, null, 'eBay cost stays empty until the net profit is typed');
  l = S.buildLine(order({ net_profit: 30 }));
  assert.strictEqual(l.profit, 50); assert.strictEqual(l.ebay_cost, 20); assert.strictEqual(l.net_profit, 30);
  assert.strictEqual(l.title, 'CarPlan All Seasons Windscreen Wash'); assert.strictEqual(l.ebay_order_id, '11-12345-67890'); assert.strictEqual(l.currency, 'GBP'); assert.strictEqual(l.store, 'Trendy UK');
  // a loss, a net profit above the profit (the eBay cost is then below zero: shown as it is), a net profit of 0
  l = S.buildLine(order({ sale_price: 80, buy_price: 100, net_profit: -25 })); assert.strictEqual(l.profit, -20); assert.strictEqual(l.ebay_cost, 5);
  l = S.buildLine(order({ net_profit: 60 })); assert.strictEqual(l.ebay_cost, -10);
  l = S.buildLine(order({ net_profit: 0 })); assert.strictEqual(l.ebay_cost, 50, 'a typed 0 is a number, not "empty"');
  // floating point traps stay exact
  l = S.buildLine(order({ sale_price: 0.3, buy_price: 0.1, net_profit: 0.1 })); assert.strictEqual(l.profit, 0.2); assert.strictEqual(l.ebay_cost, 0.1);
  l = S.buildLine(order({ sale_price: 19.99, buy_price: 12.34, net_profit: 5.55 })); assert.strictEqual(l.profit, 7.65); assert.strictEqual(l.ebay_cost, 2.1);
  // no Amazon price yet: no profit, and no eBay cost even when a net profit is typed
  l = S.buildLine(order({ buy_price: null, net_profit: 30 })); assert.strictEqual(l.amazon_price, null); assert.strictEqual(l.profit, null); assert.strictEqual(l.ebay_cost, null); assert.strictEqual(l.net_profit, 30);
  l = S.buildLine(order({ sale_price: null })); assert.strictEqual(l.ebay_price, null); assert.strictEqual(l.profit, null);
  // prices are per piece: an order of 2 pieces sold for 300 is 150 each
  l = S.buildLine(order({ quantity: 2, sale_price: 300, buy_price: 100 })); assert.strictEqual(l.ebay_price, 150); assert.strictEqual(l.quantity, 2); assert.strictEqual(l.profit, 50);
  assert.strictEqual(S.buildLine(order({ quantity: 0 })).quantity, 1); assert.strictEqual(S.buildLine(order({ quantity: 'x' })).quantity, 1);
  // a cost in another currency that could not be converted is never shown as if it were in the order's currency
  l = S.buildLine(order({ buy_price: 12, profit_note: 'no exchange rate' })); assert.strictEqual(l.amazon_price, null); assert.strictEqual(l.profit, null); assert.match(l.amazon_note, /exchange rate/);
  // the seller's own Amazon price is marked
  assert.strictEqual(S.buildLine(order({ buy_price_manual: true })).amazon_manual, true); assert.strictEqual(S.buildLine(order()).amazon_manual, false);
  // title falls back to eBay's own title, then the SKU
  assert.strictEqual(S.buildLine(order({ listing_title: null, item_title: 'From eBay' })).title, 'From eBay'); assert.strictEqual(S.buildLine(order({ listing_title: null, item_title: null, sku: 'EBAY-1' })).title, 'EBAY-1');

  // ---------- totals: per currency, only cells that have a number, exact ----------
  const lines = [
    S.buildLine(order({ id: 'a', sale_price: 150, buy_price: 100, net_profit: 30 })),
    S.buildLine(order({ id: 'b', sale_price: 0.3, buy_price: 0.1 })),
    S.buildLine(order({ id: 'c', currency: 'EUR', sale_price: 50, buy_price: 20, net_profit: 25 })),
    S.buildLine(order({ id: 'd', buy_price: null, sale_price: 10 })),
  ];
  const totals = S.totalsOf(lines);
  const gbp = totals.find((t) => t.currency === 'GBP'); const eur = totals.find((t) => t.currency === 'EUR');
  assert.strictEqual(totals.length, 2, 'a pound and a euro are never added together');
  assert.deepStrictEqual(gbp, { currency: 'GBP', lines: 3, amazon_price: 100.1, ebay_price: 160.3, profit: 50.2, ebay_cost: 20, net_profit: 30 }, 'each column adds only the cells that have a number');
  assert.deepStrictEqual(eur, { currency: 'EUR', lines: 1, amazon_price: 20, ebay_price: 50, profit: 30, ebay_cost: 5, net_profit: 25 });
  assert.deepStrictEqual(S.totalsOf([]), []); assert.strictEqual(S.totalsOf([S.buildLine(order({ buy_price: null }))])[0].profit, null, 'nothing to add is empty, not 0');

  // ---------- who is paid ----------
  const now = new Date('2026-09-27T00:00:00Z');
  assert.strictEqual(S.isPaidUser(null), false); assert.strictEqual(S.isPaidUser({}), false);
  assert.strictEqual(S.isPaidUser({ planName: 'Pro', planExpiresAt: new Date('2026-12-01') }, now), true);
  assert.strictEqual(S.isPaidUser({ planName: 'Pro', planExpiresAt: new Date('2026-09-01') }, now), false, 'a plan that has ended');
  assert.strictEqual(S.isPaidUser({ planName: 'Credit pack', planExpiresAt: null }, now), true, 'a plan without an end date');
  assert.strictEqual(S.isPaidUser({ planName: null, planExpiresAt: new Date('2027-01-01') }, now), false, 'no plan bought');
  assert.strictEqual(S.isPaidUser({ role: 'admin' }, now), true);

  // ---------- paging: free reaches its limit, a plan reaches everything, 1000 at a time ----------
  let p = S.paging({ paid: false, freeLines: 1000, offset: 0, limit: 1000, total: 2431 });
  assert.deepStrictEqual([p.take, p.hasMore, p.locked], [1000, false, true], 'free: at its limit with more orders behind it');
  p = S.paging({ paid: false, freeLines: 1000, offset: 1000, limit: 1000, total: 2431 }); assert.strictEqual(p.take, 0, 'free cannot read beyond its limit, even when asked to');
  p = S.paging({ paid: false, freeLines: 1000, offset: 0, limit: 1000, total: 400 }); assert.deepStrictEqual([p.take, p.hasMore, p.locked], [400, false, false], 'free with fewer orders than the limit: nothing to add');
  p = S.paging({ paid: false, freeLines: 2500, offset: 0, limit: 1000, total: 4000 }); assert.deepStrictEqual([p.take, p.hasMore, p.locked], [1000, true, false], 'free below its limit can still add lines');
  p = S.paging({ paid: false, freeLines: 2500, offset: 2000, limit: 1000, total: 4000 }); assert.deepStrictEqual([p.take, p.hasMore, p.locked], [500, false, true], 'and stops exactly at the limit');
  p = S.paging({ paid: true, freeLines: 1000, offset: 0, limit: 1000, total: 2431 }); assert.deepStrictEqual([p.take, p.hasMore, p.locked], [1000, true, false]);
  p = S.paging({ paid: true, freeLines: 1000, offset: 2000, limit: 1000, total: 2431 }); assert.deepStrictEqual([p.take, p.hasMore, p.locked], [431, false, false], 'the last lines: nothing more to add');
  p = S.paging({ paid: true, freeLines: 1000, offset: 0, limit: 999999, total: 5000 }); assert.strictEqual(p.take, 1000, 'never more than 1000 at a time');
  p = S.paging({ paid: true, freeLines: 1000, offset: -5, limit: 'x', total: 0 }); assert.deepStrictEqual([p.offset, p.take, p.hasMore], [0, 0, false]);

  // ---------- CSV: every column, plain numbers, text kept as text, safe for Excel ----------
  const csvLines = [
    S.buildLine(order({ net_profit: 30, listing_title: 'Wash, "Summer" edition' })),
    S.buildLine(order({ id: 'b', listing_title: '=HYPERLINK("http://x")', ebay_order_id: '22-1-2', sale_price: 80, buy_price: 100, currency: 'EUR', ebay_account_label: 'Berlin' })),
  ];
  const csv = S.csvHeader() + csvLines.map(S.csvLine).join('') + S.csvTotals(csvLines);
  assert.ok(csv.startsWith('﻿"Title","Order ID","Amazon price","eBay price","Profit","eBay cost","Net profit","Currency","Quantity","Order date","Store","eBay item number","Amazon ASIN"\r\n'), 'a byte order mark so € £ and other letters open right in Excel');
  const rows = csv.replace('﻿', '').split('\r\n').filter(Boolean);
  assert.strictEqual(rows.length, 1 + 2 + 2, 'header, two lines, one total row per currency');
  assert.strictEqual(rows[1], '"Wash, ""Summer"" edition","11-12345-67890",100.00,150.00,50.00,20.00,30.00,"GBP",1,2026-09-20,"Trendy UK","=""110001234567""","B0ABC12345"', 'quotes doubled, numbers plain (no sign), item number kept as text');
  assert.ok(rows[2].startsWith(`"'=HYPERLINK(""http://x"")"`), 'a title that looks like a formula is made harmless');
  assert.ok(rows[2].includes(',-20.00,,,"EUR",'), 'a loss is a plain negative number; empty net profit and eBay cost are empty');
  assert.strictEqual(rows[3], '"TOTAL (1 line)","",100.00,150.00,50.00,20.00,30.00,"GBP",,,"","",""');
  assert.ok(rows[4].startsWith('"TOTAL (1 line)"') && rows[4].includes('"EUR"'));
  // every row has the same number of columns as the header (naive split is safe here: no commas inside the sample titles of rows 3 and 4)
  assert.strictEqual(rows[3].split(',').length, 13); assert.strictEqual(rows[4].split(',').length, 13);
  assert.strictEqual(S.csvLine(S.buildLine(order({ legacy_item_id: '', asin: '' }))).includes('"",""'), true);

  // ---------- the routes (real code, fake data): the limit is enforced by the server ----------
  const calls = [];
  const users = { free: { role: 'user', planName: null }, paid: { role: 'user', planName: 'Pro', planExpiresAt: new Date(Date.now() + 86400000) } };
  let who = 'free'; let freeLines = 1000; let total = 2431; const saved = [];
  const fakes = {
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../models/schemas/User': { findById: () => ({ select: () => ({ lean: async () => users[who] }) }) },
    '../models/settingsModel': { getLimits: async () => ({ netProfitFreeLines: freeLines }) },
    '../models/ordersModel': {
      countNetProfitLines: async (u, f) => { calls.push({ count: f }); return total; },
      listNetProfitLines: async (u, f, o) => { calls.push({ list: o }); return Array.from({ length: Math.min(o.limit, Math.max(0, total - o.offset)) }, (_, i) => S.buildLine(order({ id: 'x' + (o.offset + i), ebay_order_id: '1-' + (o.offset + i) }))); },
      getNetProfitLine: async () => S.buildLine(order({ net_profit: 30 })),
      netProfitSummary: async (u, f) => { calls.push({ summary: f }); return { currencies: [{ currency: 'GBP', net_profit: 30, orders: 1 }], orders: 1, ordersTotal: 4 }; },
      setNetProfit: async (u, id, v) => { saved.push(['net', id, v]); return true; },
      setBuyPrice: async (u, id, v) => { saved.push(['amazon', id, v]); if (v !== null && Number(v) <= 0) throw new Error('Enter the cost of one item as a number above 0.'); return {}; },
    },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]netProfit\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/netProfit');
  Module._load = orig;
  const handler = (method, path) => { const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); return l.route.stack[l.route.stack.length - 1].handle; };
  const call = async (h, { query = {}, body = {}, params = {} } = {}) => {
    const res = { statusCode: 200, headers: {}, chunks: [] };
    res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; }; res.write = (c) => { res.chunks.push(c); }; res.end = () => { res.ended = true; }; res.headersSent = false;
    await h({ userId: 'u1', query, body, params }, res); return res;
  };

  let res = await call(handler('get', '/'));
  assert.strictEqual(res.body.paid, false); assert.strictEqual(res.body.lines.length, 1000); assert.strictEqual(res.body.locked, true); assert.strictEqual(res.body.hasMore, false); assert.strictEqual(res.body.total, 2431);
  calls.length = 0; res = await call(handler('get', '/'), { query: { offset: '1000', limit: '1000' } });
  assert.strictEqual(res.body.lines.length, 0); assert.ok(!calls.some((c) => c.list), 'a free account cannot reach past its limit by asking'); assert.strictEqual(res.body.locked, true);
  who = 'paid'; res = await call(handler('get', '/'), { query: { offset: '2000', limit: '1000' } });
  assert.strictEqual(res.body.paid, true); assert.strictEqual(res.body.lines.length, 431); assert.strictEqual(res.body.hasMore, false); assert.strictEqual(res.body.locked, false);
  res = await call(handler('get', '/'), { query: { offset: '0' } }); assert.strictEqual(res.body.lines.length, 1000); assert.strictEqual(res.body.hasMore, true);
  freeLines = 50; who = 'free'; res = await call(handler('get', '/')); assert.strictEqual(res.body.lines.length, 50, 'the admin sets the free limit'); assert.strictEqual(res.body.freeLines, 50);
  // the filters reach the model, cleaned
  calls.length = 0; await call(handler('get', '/'), { query: { q: ' wash ', accountId: 'zzz', from: 'nonsense', to: '2026-09-27T00:00:00Z', includeCancelled: '1' } });
  const f = calls.find((c) => c.count).count; assert.deepStrictEqual([f.q, f.accountId, f.from, f.includeCancelled], ['wash', null, null, true]); assert.ok(f.to instanceof Date);

  // export: free = the lines it can reach; paid = every line; totals at the end
  freeLines = 1000; total = 2431; who = 'free'; res = await call(handler('get', '/export'));
  assert.strictEqual(res.headers['Content-Type'], 'text/csv; charset=utf-8'); assert.match(res.headers['Content-Disposition'], /net-profit-\d{4}-\d{2}-\d{2}\.csv/);
  assert.strictEqual(res.chunks.join('').split('\r\n').filter(Boolean).length, 1 + 1000 + 1, 'free: header + its 1000 lines + the total');
  who = 'paid'; res = await call(handler('get', '/export'));
  assert.strictEqual(res.chunks.join('').split('\r\n').filter(Boolean).length, 1 + 2431 + 1, 'a plan: every line, more than the 1000 of one page');

  // the dashboard sum: the filters are cleaned (no search, cancelled orders never counted) and the answer is passed on
  calls.length = 0; res = await call(handler('get', '/summary'), { query: { q: 'wash', includeCancelled: '1', accountId: 'zzz', from: '2026-09-01T00:00:00Z' } });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.orders, res.body.ordersTotal, res.body.currencies[0].net_profit], [200, true, 1, 4, 30]);
  const sf = calls.find((c) => c.summary).summary; assert.deepStrictEqual([sf.q, sf.includeCancelled, sf.accountId], ['', false, null]); assert.ok(sf.from instanceof Date);

  // saving the two typed cells
  res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { netProfit: '30', amazonPrice: 100 } });
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.line.net_profit, 30); assert.deepStrictEqual(saved, [['amazon', 'a'.repeat(24), 100], ['net', 'a'.repeat(24), 30]]);
  saved.length = 0; res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { netProfit: '' } }); assert.deepStrictEqual(saved, [['net', 'a'.repeat(24), null]], 'empty clears it');
  saved.length = 0; res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { amazonPrice: '' } }); assert.deepStrictEqual(saved, [['amazon', 'a'.repeat(24), null]], 'an empty Amazon price goes back to the listing price');
  saved.length = 0; res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { netProfit: 'abc' } }); assert.strictEqual(res.statusCode, 400); assert.strictEqual(saved.length, 0);
  res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { netProfit: 1e12 } }); assert.strictEqual(res.statusCode, 400);
  res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: { amazonPrice: -5 } }); assert.strictEqual(res.statusCode, 400);
  res = await call(handler('patch', '/:id'), { params: { id: 'a'.repeat(24) }, body: {} }); assert.strictEqual(res.statusCode, 400);
  res = await call(handler('patch', '/:id'), { params: { id: 'bad' }, body: { netProfit: 1 } }); assert.strictEqual(res.statusCode, 404);

  console.log('net profit tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
