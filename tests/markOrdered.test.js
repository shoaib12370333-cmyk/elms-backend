// "Mark as ordered" with what the seller fills in (models/ordersModel markOrdered): the order gets the ordered step and the DATE, the buying price and the order
// earning go to the Net Profit sheet (only when given), and "ELMS: ordered <date>" is added to the private note in ELMS after the seller's own text and taken
// out again on Undo. An order that is already shipped is not turned back. The real model runs with the database stood in.
const assert = require('assert');
const Module = require('module');

let stored = null; // the order as the database holds it
let sets = [];
const fakes = {
  './schemas/Order': {
    findOne: () => ({ select: () => ({ lean: async () => stored }) }),
    findOneAndUpdate: async (q, u) => { sets.push(u.$set); stored = { ...stored, ...u.$set }; return { toObject: () => ({ _id: { toString: () => 'o1' }, userId: { toString: () => 'u1' }, ebayOrderId: '11-1', sku: 'B0X', quantity: 1, salePrice: 30, currency: 'GBP', ...stored }) }; },
  },
  './schemas/Listing': {}, './schemas/Import': {},
};
const orig = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /ordersModel\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
const M = require('../models/ordersModel');
Module._load = orig;
const { applyMark, planNote } = require('../services/orderNoteMark');

const day = (iso) => new Date(iso + 'T12:00:00Z');

(async () => {
  // ---------- the note text ----------
  assert.strictEqual(applyMark('', true, day('2026-09-27')), 'ELMS: ordered 27 Sep 2026');
  assert.strictEqual(applyMark('call buyer', true, day('2026-09-05')), 'call buyer | ELMS: ordered 5 Sep 2026');
  assert.strictEqual(applyMark('call buyer | ELMS: ordered 5 Sep 2026', false), 'call buyer');
  assert.strictEqual(applyMark('ELMS: ordered 5 Sep 2026', false), '');
  assert.strictEqual(applyMark('mine', false), 'mine', 'no mark: the seller\'s note is left as it is');
  assert.strictEqual(applyMark('x | ELMS: ordered 1 Jan 2026', true, day('2026-09-27')), 'x | ELMS: ordered 1 Jan 2026', 'not added twice');
  assert.strictEqual(applyMark('a'.repeat(1970), true, day('2026-09-27'), 2000).length, 1970 + 3 + 'ELMS: ordered 27 Sep 2026'.length, "ELMS's own note has room for 2000 characters (eBay's has 255)");
  assert.strictEqual(applyMark('a'.repeat(1990), true, day('2026-09-27'), 2000), 'a'.repeat(1990), 'no room: the note is left as it is');
  assert.strictEqual(planNote('a'.repeat(1999), true, day('2026-09-27'), 2000).action, 'none');

  // ---------- ordered: the step, the date, the note, the sheet figures ----------
  stored = { fulfillmentStatus: 'pending', sellerNote: 'call buyer' };
  let out = await M.markOrdered('u1', 'o1', { ordered: true, date: day('2026-09-20'), buyingPrice: 10, orderEarning: 25 });
  assert.deepStrictEqual(sets[0], { fulfillmentStatus: 'ordered_from_amazon', orderedAt: day('2026-09-20'), sellerNote: 'call buyer | ELMS: ordered 20 Sep 2026', sheetAmazonPrice: 10, orderEarning: 25 });
  assert.deepStrictEqual([out.order.fulfillment_status, out.order.ordered_at, out.order.seller_note, out.order.sheet_amazon_price, out.order.order_earning, out.order.net_profit], ['ordered_from_amazon', day('2026-09-20'), 'call buyer | ELMS: ordered 20 Sep 2026', 10, 25, 15], 'the net profit is worked out from what was typed');
  // nothing given: the sheet figures are left alone
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '', sheetAmazonPrice: 7, orderEarning: 20 };
  await M.markOrdered('u1', 'o1', { ordered: true, date: day('2026-09-21') });
  assert.ok(!('sheetAmazonPrice' in sets[0]) && !('orderEarning' in sets[0]), 'only what is given is written'); assert.strictEqual(sets[0].sellerNote, 'ELMS: ordered 21 Sep 2026');
  // only the price
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '' }; await M.markOrdered('u1', 'o1', { ordered: true, date: day('2026-09-21'), buyingPrice: '8.999' });
  assert.deepStrictEqual([sets[0].sheetAmazonPrice, 'orderEarning' in sets[0]], [9, false], 'rounded to the cent');
  // an empty one clears it
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '', orderEarning: 20 }; await M.markOrdered('u1', 'o1', { ordered: true, date: day('2026-09-21'), orderEarning: '' });
  assert.strictEqual(sets[0].orderEarning, null);
  // no date given: today
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '' }; await M.markOrdered('u1', 'o1', { ordered: true });
  assert.ok(sets[0].orderedAt instanceof Date && Math.abs(sets[0].orderedAt - Date.now()) < 5000 && /^ELMS: ordered \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(sets[0].sellerNote));

  // ---------- undo: the mark comes out, the date goes, the figures stay ----------
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', orderedAt: day('2026-09-20'), sellerNote: 'call buyer | ELMS: ordered 20 Sep 2026', sheetAmazonPrice: 10, orderEarning: 25 };
  out = await M.markOrdered('u1', 'o1', { ordered: false });
  assert.deepStrictEqual(sets[0], { fulfillmentStatus: 'pending', orderedAt: null, sellerNote: 'call buyer' }, 'the seller\'s own note stays; the typed figures are not touched');
  assert.deepStrictEqual([out.order.ordered_at, out.order.sheet_amazon_price, out.order.order_earning], [null, 10, 25]);
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', sellerNote: 'ELMS: ordered 20 Sep 2026' }; await M.markOrdered('u1', 'o1', { ordered: false });
  assert.strictEqual(sets[0].sellerNote, '', 'nothing else in the note: it is empty again');

  // ---------- not turned back / not there ----------
  sets = []; stored = { fulfillmentStatus: 'shipped', sellerNote: '' };
  assert.deepStrictEqual(await M.markOrdered('u1', 'o1', { ordered: true }), { error: 'shipped' }); assert.strictEqual(sets.length, 0, 'a shipped order is not touched');
  stored = { fulfillmentStatus: 'delivered', sellerNote: '' }; assert.strictEqual((await M.markOrdered('u1', 'o1', { ordered: false })).error, 'shipped');
  stored = null; assert.deepStrictEqual(await M.markOrdered('u1', 'nope', { ordered: true }), { error: 'not_found' });

  console.log('mark ordered tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
