// "Mark as ordered" with what the seller fills in (models/ordersModel markOrdered): the order gets the ordered step, the DELIVERY date (when the parcel arrives), the
// buying price and the order earning go to the Net Profit sheet (only when given), and "ELMS: ordered, delivery <date>" is added to the private note in ELMS
// after the seller's own text (a new delivery date replaces the old one) and taken out again on Undo. An order that is already shipped is not turned back.
// The real model runs with the database stood in.
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
  assert.strictEqual(applyMark('', true, day('2026-09-27')), 'ELMS: ordered, delivery 27 Sep 2026');
  assert.strictEqual(applyMark('call buyer', true, day('2026-09-05')), 'call buyer | ELMS: ordered, delivery 5 Sep 2026');
  assert.strictEqual(applyMark('call buyer', true, null), 'call buyer | ELMS: ordered', 'no delivery date: just "ordered"');
  assert.strictEqual(applyMark('call buyer | ELMS: ordered, delivery 5 Sep 2026', false), 'call buyer');
  assert.strictEqual(applyMark('ELMS: ordered, delivery 5 Sep 2026', false), '');
  assert.strictEqual(applyMark('ELMS: ordered 5 Sep 2026', false), '', 'a mark of the first version comes out too');
  assert.strictEqual(applyMark('mine', false), 'mine', "no mark: the seller's note is left as it is");
  assert.strictEqual(applyMark('x | ELMS: ordered, delivery 27 Sep 2026', true, day('2026-09-27')), 'x | ELMS: ordered, delivery 27 Sep 2026', 'not added twice');
  assert.strictEqual(applyMark('x | ELMS: ordered, delivery 20 Sep 2026', true, day('2026-09-27')), 'x | ELMS: ordered, delivery 27 Sep 2026', 'a new delivery date replaces the old one');
  assert.strictEqual(applyMark('x | ELMS: ordered 20 Sep 2026 | y', true, day('2026-09-27')), 'x | y | ELMS: ordered, delivery 27 Sep 2026', 'the seller\'s text on both sides is kept');
  assert.strictEqual(applyMark('a'.repeat(1950), true, day('2026-09-27'), 2000).length, 1950 + 3 + 'ELMS: ordered, delivery 27 Sep 2026'.length, "ELMS's own note has room for 2000 characters (eBay's has 255)");
  assert.strictEqual(applyMark('a'.repeat(1980), true, day('2026-09-27'), 2000), 'a'.repeat(1980) + ' | ELMS: ordered', 'no room for the date: the short mark');
  assert.strictEqual(applyMark('a'.repeat(1990), true, day('2026-09-27'), 2000), 'a'.repeat(1990), 'no room even for that: the note is left as it is');
  assert.strictEqual(planNote('a'.repeat(1999), true, day('2026-09-27'), 2000).action, 'none');

  // ---------- ordered: the step, the delivery date, the note, the sheet figures ----------
  stored = { fulfillmentStatus: 'pending', sellerNote: 'call buyer' };
  let out = await M.markOrdered('u1', 'o1', { ordered: true, deliveryDate: day('2026-09-30'), buyingPrice: 10, orderEarning: 25 });
  assert.strictEqual(sets[0].fulfillmentStatus, 'ordered_from_amazon'); assert.ok(sets[0].orderedAt instanceof Date && Math.abs(sets[0].orderedAt - Date.now()) < 5000, 'the moment it was marked');
  assert.deepStrictEqual([sets[0].deliveryDate, sets[0].sellerNote, sets[0].sheetAmazonPrice, sets[0].orderEarning], [day('2026-09-30'), 'call buyer | ELMS: ordered, delivery 30 Sep 2026', 10, 25]);
  assert.deepStrictEqual([out.order.fulfillment_status, out.order.delivery_date, out.order.seller_note, out.order.sheet_amazon_price, out.order.order_earning, out.order.net_profit], ['ordered_from_amazon', day('2026-09-30'), 'call buyer | ELMS: ordered, delivery 30 Sep 2026', 10, 25, 15], 'the net profit is worked out from what was typed');
  // nothing given: the sheet figures are left alone
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '', sheetAmazonPrice: 7, orderEarning: 20 };
  await M.markOrdered('u1', 'o1', { ordered: true, deliveryDate: day('2026-09-21') });
  assert.ok(!('sheetAmazonPrice' in sets[0]) && !('orderEarning' in sets[0]), 'only what is given is written'); assert.strictEqual(sets[0].sellerNote, 'ELMS: ordered, delivery 21 Sep 2026');
  // no delivery date: the plain mark
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '' }; await M.markOrdered('u1', 'o1', { ordered: true });
  assert.deepStrictEqual([sets[0].deliveryDate, sets[0].sellerNote], [null, 'ELMS: ordered']);
  // edit the delivery date later: the mark is replaced, the moment it was marked stays
  const first = day('2026-09-19');
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', orderedAt: first, deliveryDate: day('2026-09-24'), sellerNote: 'mine | ELMS: ordered, delivery 24 Sep 2026' };
  await M.markOrdered('u1', 'o1', { ordered: true, deliveryDate: day('2026-09-26') });
  assert.deepStrictEqual([sets[0].orderedAt, sets[0].deliveryDate, sets[0].sellerNote], [first, day('2026-09-26'), 'mine | ELMS: ordered, delivery 26 Sep 2026']);
  // the delivery date not given again: the one there stays
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', orderedAt: first, deliveryDate: day('2026-09-24'), sellerNote: 'ELMS: ordered, delivery 24 Sep 2026' };
  await M.markOrdered('u1', 'o1', { ordered: true, buyingPrice: 9 });
  assert.deepStrictEqual([sets[0].deliveryDate, sets[0].sellerNote, sets[0].sheetAmazonPrice], [day('2026-09-24'), 'ELMS: ordered, delivery 24 Sep 2026', 9]);
  // rounded to the cent; an empty figure clears it
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '' }; await M.markOrdered('u1', 'o1', { ordered: true, buyingPrice: '8.999' });
  assert.deepStrictEqual([sets[0].sheetAmazonPrice, 'orderEarning' in sets[0]], [9, false]);
  sets = []; stored = { fulfillmentStatus: 'pending', sellerNote: '', orderEarning: 20 }; await M.markOrdered('u1', 'o1', { ordered: true, orderEarning: '' });
  assert.strictEqual(sets[0].orderEarning, null);

  // ---------- undo: the mark comes out, the dates go, the figures stay ----------
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', orderedAt: first, deliveryDate: day('2026-09-24'), sellerNote: 'call buyer | ELMS: ordered, delivery 24 Sep 2026', sheetAmazonPrice: 10, orderEarning: 25 };
  out = await M.markOrdered('u1', 'o1', { ordered: false });
  assert.deepStrictEqual(sets[0], { fulfillmentStatus: 'pending', orderedAt: null, deliveryDate: null, sellerNote: 'call buyer' }, "the seller's own note stays; the typed figures are not touched");
  assert.deepStrictEqual([out.order.ordered_at, out.order.delivery_date, out.order.sheet_amazon_price, out.order.order_earning], [null, null, 10, 25]);
  sets = []; stored = { fulfillmentStatus: 'ordered_from_amazon', sellerNote: 'ELMS: ordered, delivery 24 Sep 2026' }; await M.markOrdered('u1', 'o1', { ordered: false });
  assert.strictEqual(sets[0].sellerNote, '', 'nothing else in the note: it is empty again');

  // ---------- not turned back / not there ----------
  sets = []; stored = { fulfillmentStatus: 'shipped', sellerNote: '' };
  assert.deepStrictEqual(await M.markOrdered('u1', 'o1', { ordered: true }), { error: 'shipped' }); assert.strictEqual(sets.length, 0, 'a shipped order is not touched');
  stored = { fulfillmentStatus: 'delivered', sellerNote: '' }; assert.strictEqual((await M.markOrdered('u1', 'o1', { ordered: false })).error, 'shipped');
  stored = null; assert.deepStrictEqual(await M.markOrdered('u1', 'nope', { ordered: true }), { error: 'not_found' });

  console.log('mark ordered tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
