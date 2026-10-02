// The Net Profit sheet: the money is worked out in whole cents (so the numbers are exact). The seller types BUYING PRICE ("amazon_price" in the data) and ORDER EARNING (both empty
// until typed); EBAY COST = EBAY PRICE - ORDER EARNING and NET PROFIT = ORDER EARNING - AMAZON PRICE are worked out, PROFIT = EBAY PRICE - AMAZON PRICE;
// what cannot be worked out yet is empty (never 0), every price is for the whole order line, currencies are never mixed, a free account reaches only
// its lines, and the .xlsx export has every column, a bold coloured header, the Net profit column coloured by sign, and a currency sign (not "USD" text).
const assert = require('assert');
const Module = require('module');
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const S = require('../services/netProfitService');
const X = require('../services/netProfitXlsx');

const order = (over = {}) => ({ id: 'o1', listing_title: 'CarPlan All Seasons Windscreen Wash', ebay_order_id: '11-12345-67890', legacy_item_id: '110001234567', asin: 'B0ABC12345', quantity: 1, sale_price: 150, sheet_amazon_price: null, order_earning: null, net_profit_typed: null, currency: 'GBP', ebay_account_label: 'Trendy UK', ebay_created_at: '2026-09-20T10:00:00Z', order_status: 'shipped', ...over });

(async () => {
  // ---------- cents: exact, half away from zero ----------
  assert.strictEqual(S.cents(0.1 + 0.2), 30); assert.strictEqual(S.cents(1.005), 101); assert.strictEqual(S.cents(-1.005), -101); assert.strictEqual(S.cents('19.99'), 1999);
  assert.strictEqual(S.cents(null), null); assert.strictEqual(S.cents(''), null); assert.strictEqual(S.cents('abc'), null); assert.strictEqual(S.cents(0), 0);
  assert.strictEqual(S.money(1999), 19.99); assert.strictEqual(S.money(null), null);

  // ---------- nothing typed: only the eBay price; everything else is empty (the Amazon price is NOT taken from the listing any more) ----------
  let l = S.buildLine(order({ buy_price: 100 })); // a cost ELMS knows from the listing is ignored by the sheet
  assert.deepStrictEqual([l.amazon_price, l.ebay_price, l.profit, l.order_earning, l.ebay_cost, l.net_profit, l.net_profit_older], [null, 150, null, null, null, null, false]);
  // the Amazon price typed: PROFIT only
  l = S.buildLine(order({ sheet_amazon_price: 100 }));
  assert.deepStrictEqual([l.amazon_price, l.profit, l.order_earning, l.ebay_cost, l.net_profit], [100, 50, null, null, null]);
  // the order earning typed alone: EBAY COST (what eBay kept) needs no Amazon price
  l = S.buildLine(order({ order_earning: 130 }));
  assert.deepStrictEqual([l.amazon_price, l.profit, l.ebay_cost, l.net_profit], [null, null, 20, null]);
  // both typed: everything is worked out. 150 sold, 100 on Amazon, eBay paid out 130 -> profit 50, eBay cost 20, net profit 30
  l = S.buildLine(order({ sheet_amazon_price: 100, order_earning: 130 }));
  assert.deepStrictEqual([l.amazon_price, l.ebay_price, l.profit, l.order_earning, l.ebay_cost, l.net_profit], [100, 150, 50, 130, 20, 30]);
  assert.strictEqual(l.profit - l.net_profit, l.ebay_cost, 'PROFIT - NET PROFIT is EBAY COST, as before');
  assert.strictEqual(l.title, 'CarPlan All Seasons Windscreen Wash'); assert.strictEqual(l.ebay_order_id, '11-12345-67890'); assert.strictEqual(l.currency, 'GBP'); assert.strictEqual(l.store, 'Trendy UK');
  // a loss, an earning above the price (eBay cost below zero: shown as it is), typed zeros are numbers not "empty"
  l = S.buildLine(order({ sale_price: 80, sheet_amazon_price: 100, order_earning: 70 })); assert.deepStrictEqual([l.profit, l.ebay_cost, l.net_profit], [-20, 10, -30]);
  l = S.buildLine(order({ sale_price: 30, sheet_amazon_price: 10, order_earning: 35 })); assert.deepStrictEqual([l.ebay_cost, l.net_profit], [-5, 25]);
  l = S.buildLine(order({ sheet_amazon_price: 0, order_earning: 0 })); assert.deepStrictEqual([l.profit, l.ebay_cost, l.net_profit], [150, 150, 0]);
  // floating point traps stay exact
  l = S.buildLine(order({ sale_price: 0.3, sheet_amazon_price: 0.1, order_earning: 0.2 })); assert.deepStrictEqual([l.profit, l.ebay_cost, l.net_profit], [0.2, 0.1, 0.1]);
  l = S.buildLine(order({ sale_price: 19.99, sheet_amazon_price: 12.34, order_earning: 18.1 })); assert.deepStrictEqual([l.profit, l.ebay_cost, l.net_profit], [7.65, 1.89, 5.76]);
  l = S.buildLine(order({ sale_price: null, sheet_amazon_price: 5, order_earning: 4 })); assert.deepStrictEqual([l.ebay_price, l.profit, l.ebay_cost, l.net_profit], [null, null, null, -1], 'no eBay price: no profit and no eBay cost; the net profit does not need it');
  // every price is for the WHOLE order line: an order of 2 pieces sold for 300 is one line of 300
  l = S.buildLine(order({ quantity: 2, sale_price: 300, sheet_amazon_price: 200, order_earning: 260 })); assert.deepStrictEqual([l.ebay_price, l.quantity, l.profit, l.ebay_cost, l.net_profit], [300, 2, 100, 40, 60]);
  assert.strictEqual(S.buildLine(order({ quantity: 0 })).quantity, 1); assert.strictEqual(S.buildLine(order({ quantity: 'x' })).quantity, 1);
  // a net profit typed in the first version of the sheet stays until both figures are typed
  l = S.buildLine(order({ net_profit_typed: 30 })); assert.deepStrictEqual([l.net_profit, l.net_profit_older, l.profit, l.ebay_cost], [30, true, null, null]);
  l = S.buildLine(order({ net_profit_typed: 30, sheet_amazon_price: 100 })); assert.deepStrictEqual([l.net_profit, l.net_profit_older], [30, true], 'one figure is not enough to replace it');
  l = S.buildLine(order({ net_profit_typed: 30, sheet_amazon_price: 100, order_earning: 120 })); assert.deepStrictEqual([l.net_profit, l.net_profit_older], [20, false], 'both typed: the worked-out figure wins');
  assert.strictEqual(S.resolveNetProfit(130, 100, 5), 30); assert.strictEqual(S.resolveNetProfit(null, 100, 5), 5); assert.strictEqual(S.resolveNetProfit(null, null, null), null); assert.strictEqual(S.resolveNetProfit(0.3, 0.1, null), 0.2);
  // the ad fee is what eBay reported for the order (Promoted Listings): shown as it is, and it changes NOTHING else - eBay takes it off before
  // payout, so it is already inside EBAY COST and the ORDER EARNING; taking it off the net profit again would count it twice
  l = S.buildLine(order({ sale_price: 150, sheet_amazon_price: 100, order_earning: 130, ad_fee: 12 }));
  assert.deepStrictEqual([l.ad_fee, l.ebay_cost, l.net_profit, l.profit], [12, 20, 30, 50]);
  assert.strictEqual(S.buildLine(order({ order_earning: 130, ad_fee: 0 })).ad_fee, 0, '0 = eBay was asked and there was none: shown as 0, not empty');
  assert.strictEqual(S.buildLine(order({ order_earning: 130 })).ad_fee, null, 'not fetched yet is empty, never 0');
  assert.strictEqual(S.buildLine(order({ ad_fee: 0.1 + 0.2 })).ad_fee, 0.3, 'exact cents');
  // title falls back to eBay's own title, then the SKU
  assert.strictEqual(S.buildLine(order({ listing_title: null, item_title: 'From eBay' })).title, 'From eBay'); assert.strictEqual(S.buildLine(order({ listing_title: null, item_title: null, sku: 'EBAY-1' })).title, 'EBAY-1');

  // ---------- totals: per currency, only cells that have a number, exact ----------
  const lines = [
    S.buildLine(order({ id: 'a', sale_price: 150, sheet_amazon_price: 100, order_earning: 130 })),
    S.buildLine(order({ id: 'b', sale_price: 0.3, sheet_amazon_price: 0.1 })),
    S.buildLine(order({ id: 'c', currency: 'EUR', sale_price: 50, sheet_amazon_price: 20, order_earning: 45 })),
    S.buildLine(order({ id: 'd', sale_price: 10 })),
  ];
  const totals = S.totalsOf(lines);
  const gbp = totals.find((t) => t.currency === 'GBP'); const eur = totals.find((t) => t.currency === 'EUR');
  assert.strictEqual(totals.length, 2, 'a pound and a euro are never added together');
  assert.deepStrictEqual(gbp, { currency: 'GBP', lines: 3, amazon_price: 100.1, ebay_price: 160.3, profit: 50.2, order_earning: 130, ebay_cost: 20, ad_fee: null, net_profit: 30 }, 'each column adds only the cells that have a number');
  assert.deepStrictEqual(eur, { currency: 'EUR', lines: 1, amazon_price: 20, ebay_price: 50, profit: 30, order_earning: 45, ebay_cost: 5, ad_fee: null, net_profit: 25 });
  assert.deepStrictEqual(S.totalsOf([]), []); assert.strictEqual(S.totalsOf([S.buildLine(order())])[0].profit, null, 'nothing to add is empty, not 0');
  const adTotals = S.totalsOf([1.1, 2.2, 0, null].map((ad_fee) => S.buildLine(order({ ad_fee }))));
  assert.strictEqual(adTotals[0].ad_fee, 3.3, 'the ad fee column adds in exact cents and skips the line that has none yet');
  assert.strictEqual(S.totalsOf([S.buildLine(order())])[0].ad_fee, null, 'no ad fee fetched anywhere: empty, not 0');

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

  // ---------- currency signs: never the plain 3-letter code ----------
  assert.strictEqual(X.currencySymbol('USD'), '$'); assert.strictEqual(X.currencySymbol('GBP'), '£'); assert.strictEqual(X.currencySymbol('EUR'), '€');
  assert.strictEqual(X.currencySymbol('xyz'), 'XYZ', 'a currency ELMS has no sign for: its code, not blank');
  assert.strictEqual(X.currencySymbol(''), '');

  // ---------- the .xlsx workbook: header bold + coloured, Net profit coloured by sign, a currency sign on every money cell, a bold total row ----------
  async function readBack(build) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    const ended = new Promise((resolve) => stream.on('end', resolve));
    await build(stream);
    stream.end();
    await ended;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.concat(chunks));
    return wb.worksheets[0];
  }

  const xlsxLines = [
    S.buildLine(order({ sheet_amazon_price: 100, order_earning: 130, ad_fee: 12, listing_title: 'Wash, "Summer" edition' })),
    S.buildLine(order({ id: 'b', listing_title: '=HYPERLINK("http://x")', ebay_order_id: '22-1-2', sale_price: 80, sheet_amazon_price: 100, order_earning: 70, currency: 'EUR', ebay_account_label: 'Berlin' })), // a loss: net profit -30
  ];
  const ws = await readBack(async (stream) => {
    const sheet = X.openNetProfitWorkbook(stream);
    xlsxLines.forEach((l) => sheet.addLine(l));
    S.totalsOf(xlsxLines).forEach((t) => sheet.addTotal(t));
    await sheet.finish();
  });
  assert.deepStrictEqual(ws.getRow(1).values.slice(1), ['Title', 'Order ID', 'Buying price', 'eBay price', 'Profit', 'Order earning', 'eBay cost', 'Ad fee', 'Net profit', 'Quantity', 'Order date', 'Store', 'eBay item number', 'Amazon ASIN'], 'no separate Currency column - the sign is already on every money cell');
  assert.deepStrictEqual(ws.getRow(1).getCell(1).font, { bold: true, color: { argb: 'FFFFFFFF' } }, 'the header is bold, white on the app\'s own blue');
  assert.deepStrictEqual(ws.getRow(1).getCell(1).fill, { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0064D2' } });
  assert.strictEqual(ws.getRow(2).getCell(1).value, 'Wash, "Summer" edition', 'a title is never quote-escaped or formula-guarded here - a real spreadsheet cell holds it as text as-is, not as a CSV string');
  assert.strictEqual(ws.getRow(2).getCell(3).value, 100);
  assert.strictEqual(ws.getRow(2).getCell(3).numFmt, '"£"#,##0.00;[Red]-"£"#,##0.00', 'the sign is on the money cell itself, not a separate "GBP" column');
  assert.strictEqual(ws.getRow(2).getCell(8).value, 12, 'the Ad fee column sits right after eBay cost');
  assert.strictEqual(ws.getRow(2).getCell(8).numFmt, '"£"#,##0.00;[Red]-"£"#,##0.00');
  assert.strictEqual(ws.getRow(3).getCell(8).value, null, 'an ad fee not fetched yet is an empty cell');
  assert.deepStrictEqual(ws.getRow(2).getCell(9).font, { color: { argb: 'FF15803D' } }, 'a positive net profit is green');
  assert.strictEqual(ws.getRow(3).getCell(1).value, '=HYPERLINK("http://x")', 'kept as plain text - a real spreadsheet cell is never run as a formula just because it looks like one');
  assert.strictEqual(ws.getRow(3).getCell(9).value, -30); assert.deepStrictEqual(ws.getRow(3).getCell(9).font, { color: { argb: 'FFDC2626' } }, 'a loss is red');
  assert.strictEqual(ws.getRow(3).getCell(3).numFmt, '"€"#,##0.00;[Red]-"€"#,##0.00');
  assert.strictEqual(ws.getRow(3).getCell(13).value, '110001234567', 'the eBay item number is text (kept as a string), not a number that Excel would round or turn into 1.1E+11');
  assert.strictEqual(ws.getRow(4).getCell(1).value, 'TOTAL (1 line)'); assert.strictEqual(ws.getRow(5).getCell(1).value, 'TOTAL (1 line)');
  assert.deepStrictEqual(ws.getRow(4).getCell(1).font, { bold: true }, 'the total row is bold');
  assert.strictEqual(ws.rowCount, 5, 'header, two lines, one total row per currency');

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
      getNetProfitLine: async () => S.buildLine(order({ sheet_amazon_price: 100, order_earning: 130 })),
      netProfitSummary: async (u, f) => { calls.push({ summary: f }); return { currencies: [{ currency: 'GBP', net_profit: 30, orders: 1 }], orders: 1, ordersTotal: 4 }; },
      setSheetInputs: async (u, id, inputs) => { saved.push([id, inputs]); return true; },
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

  // export: a real .xlsx now (openNetProfitWorkbook pipes into the response, so the fake res must be a real writable stream here,
  // unlike the plain object the other routes' fakes above use).
  const callExport = async (h, { query = {} } = {}) => {
    const res = new PassThrough();
    res.statusCode = 200; res.headers = {}; res.headersSent = false;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    const chunks = []; res.on('data', (c) => chunks.push(c));
    const ended = new Promise((resolve) => res.on('finish', resolve));
    await h({ userId: 'u1', query, body: {}, params: {} }, res);
    res.end();
    await ended;
    res.buffer = Buffer.concat(chunks);
    return res;
  };
  const rowCountOf = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb.worksheets[0].rowCount; };

  // export: free = the lines it can reach; paid = every line; totals at the end
  freeLines = 1000; total = 2431; who = 'free'; res = await callExport(handler('get', '/export'));
  assert.strictEqual(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers['Content-Disposition'], /net-profit-\d{4}-\d{2}-\d{2}\.xlsx/);
  assert.strictEqual(await rowCountOf(res.buffer), 1 + 1000 + 1, 'free: header + its 1000 lines + the total');
  who = 'paid'; res = await callExport(handler('get', '/export'));
  assert.strictEqual(await rowCountOf(res.buffer), 1 + 2431 + 1, 'a plan: every line, more than the 1000 of one page');

  // the dashboard sum: the filters are cleaned (no search, cancelled orders never counted) and the answer is passed on
  calls.length = 0; res = await call(handler('get', '/summary'), { query: { q: 'wash', includeCancelled: '1', accountId: 'zzz', from: '2026-09-01T00:00:00Z' } });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.orders, res.body.ordersTotal, res.body.currencies[0].net_profit], [200, true, 1, 4, 30]);
  const sf = calls.find((c) => c.summary).summary; assert.deepStrictEqual([sf.q, sf.includeCancelled, sf.accountId], ['', false, null]); assert.ok(sf.from instanceof Date);

  // saving the two typed cells: the Amazon price and the order earning; the answer is the line as the sheet now shows it
  const id = 'a'.repeat(24);
  res = await call(handler('patch', '/:id'), { params: { id }, body: { amazonPrice: '100', orderEarning: 130 } });
  assert.strictEqual(res.statusCode, 200); assert.deepStrictEqual([res.body.line.net_profit, res.body.line.ebay_cost, res.body.line.profit], [30, 20, 50]); assert.deepStrictEqual(saved, [[id, { amazonPrice: 100, orderEarning: 130 }]]);
  saved.length = 0; await call(handler('patch', '/:id'), { params: { id }, body: { orderEarning: '' } }); assert.deepStrictEqual(saved, [[id, { orderEarning: null }]], 'empty clears it, and only that one is touched');
  saved.length = 0; await call(handler('patch', '/:id'), { params: { id }, body: { amazonPrice: null } }); assert.deepStrictEqual(saved, [[id, { amazonPrice: null }]]);
  saved.length = 0; await call(handler('patch', '/:id'), { params: { id }, body: { amazonPrice: 0 } }); assert.deepStrictEqual(saved, [[id, { amazonPrice: 0 }]], 'an Amazon price of 0 is allowed');
  saved.length = 0; await call(handler('patch', '/:id'), { params: { id }, body: { orderEarning: -4.5 } }); assert.deepStrictEqual(saved, [[id, { orderEarning: -4.5 }]], 'an earning can be below zero');
  saved.length = 0; await call(handler('patch', '/:id'), { params: { id }, body: { netProfit: '30' } }); assert.deepStrictEqual(saved, [[id, { netProfit: 30 }]], 'a client of the first version of the sheet still works');
  saved.length = 0;
  for (const [body, message] of [[{ amazonPrice: 'abc' }, /buying price as a number/], [{ orderEarning: 'abc' }, /order earning as a number/], [{ netProfit: 'abc' }, /net profit as a number/], [{ amazonPrice: -5 }, /0 or more/], [{ orderEarning: 1e12 }, /too large/], [{ amazonPrice: 1e12 }, /0 or more/], [{ netProfit: 1e12 }, /too large/], [{}, /Nothing to save/]]) {
    res = await call(handler('patch', '/:id'), { params: { id }, body }); assert.strictEqual(res.statusCode, 400, JSON.stringify(body)); assert.match(res.body.error, message);
  }
  assert.strictEqual(saved.length, 0, 'a refused figure saves nothing');
  res = await call(handler('patch', '/:id'), { params: { id: 'bad' }, body: { orderEarning: 1 } }); assert.strictEqual(res.statusCode, 404);

  console.log('net profit tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
