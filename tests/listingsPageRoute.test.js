// GET /api/listings (a page), /summary, /ids, POST /rows, GET /export and GET /:id?full=1: what a request may ask for is cleaned (only real statuses, a store id
// that is an id, page 1.., limit 1..200, a known sort, a search text of at most 100 characters), a status or a store that cannot exist answers an empty list
// (never everything), and the answers have the shape the page uses. The real routes run; the model is a spy.
const assert = require('assert');
const Module = require('module');

const real = require('../models/listingsModel');
const calls = [];
let pageAnswer = { listings: [{ id: 'l1' }], total: 1, page: 1, limit: 50, pages: 1 };
let pageFails = false;
let fullAnswer = { id: 'l1', description: 'D' };
const model = {
  ...real,
  listListingsPage: async (u, o) => { calls.push(['page', o]); if (pageFails) throw new Error('database down'); return pageAnswer; },
  summarizeLiveListings: async (u, o) => { calls.push(['summary', o]); return { counts: { all: 2 }, totals: { views: 3 } }; },
  listListingIds: async (u, o) => { calls.push(['ids', o]); return ['a', 'b']; },
  listRowsByIds: async (u, ids) => { calls.push(['rows', ids]); return ids.map((id) => ({ id })); },
  getListingById: async () => ({ id: 'l1', plain: true }),
  getListingFull: async (u, id) => { calls.push(['full', id]); return id === 'missing' ? null : fullAnswer; },
  eachListingChunk: async (u, o, fn) => { calls.push(['export', o]); await fn([{ title: 'A "quoted", title', sku: 'S1', sell_price: 9.5, quantity: 2, category_id: '177', status: 'published' }, { title: '=HYPERLINK("http://x")', sku: 'S2', sell_price: null, quantity: 1, category_id: null, status: 'published' }]); },
};
const fakes = {
  '../models/listingsModel': model,
  '../services/ebayListingService': { deleteOffer: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'tok' },
};
const origLoad = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]listings\.js/.test(parent.filename)) return fakes[request]; return origLoad.apply(this, arguments); };
const router = require('../routes/listings');
Module._load = origLoad;

const handler = (method, path) => { const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); if (!l) throw new Error('no route ' + method + ' ' + path); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200, headers: {}, chunks: [] }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.write = (c) => { r.chunks.push(c); }; r.end = () => { r.ended = true; }; return r; };
const call = async (method, path, req) => { const res = fakeRes(); await handler(method, path)({ userId: 'u1', query: {}, body: {}, params: {}, ...req }, res); return res; };
const ACC = '0123456789abcdef01234567';

(async () => {
  // ---------- the order of the routes: the fixed words come before /:id ----------
  const paths = router.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
  for (const p of ['/summary', '/ids', '/export']) assert.ok(paths.indexOf(p) < paths.indexOf('/:id'), p + ' is above GET /:id (or "summary" would be read as an id)');

  // ---------- a page ----------
  let res = await call('get', '/', { query: {} });
  assert.deepStrictEqual(res.body, { success: true, listings: [{ id: 'l1' }], total: 1, page: 1, limit: 50, pages: 1 });
  assert.deepStrictEqual(calls[0][1], { statuses: [], accountId: null, source: null, q: '', sort: 'newest', vero: false, page: 1, limit: 50 }, 'page 1, 50 a page, newest first, no source filter');
  calls.length = 0; await call('get', '/', { query: { status: 'published, bogus ,ended', accountId: ACC, q: '  kettle  ', sort: 'profit', vero: '1', page: '3', limit: '12', source: 'cj' } });
  assert.deepStrictEqual(calls[0][1], { statuses: ['published', 'ended'], accountId: ACC, source: 'cj', q: 'kettle', sort: 'profit', vero: true, page: 3, limit: 12 }, 'only real statuses; trimmed search; a real source');
  calls.length = 0; await call('get', '/', { query: { source: 'ebay' } });
  assert.strictEqual(calls[0][1].source, null, 'an unrecognized source is ignored (every source), never "nothing"');
  calls.length = 0; await call('get', '/', { query: { sort: 'drop table', page: '-5', limit: '100000', q: 'x'.repeat(500) } });
  assert.deepStrictEqual([calls[0][1].sort, calls[0][1].page, calls[0][1].limit, calls[0][1].q.length], ['newest', 1, 200, 100], 'an unknown sort is "newest"; page and limit are made safe');
  // a status or a store that cannot exist: an empty list, the database is not asked
  calls.length = 0; res = await call('get', '/', { query: { status: 'bogus' } });
  assert.deepStrictEqual([res.body.listings.length, res.body.total, calls.length], [0, 0, 0], 'a status that does not exist is not "every status"');
  res = await call('get', '/', { query: { accountId: 'not-an-id' } }); assert.deepStrictEqual([res.body.listings.length, calls.length], [0, 0], 'a store that is not an id');
  pageFails = true; const log = console.error; console.error = () => {}; res = await call('get', '/', { query: {} }); console.error = log; pageFails = false;
  assert.strictEqual(res.statusCode, 500); assert.strictEqual(res.body.error, 'Could not load listings.');

  // ---------- summary, ids, rows ----------
  calls.length = 0; res = await call('get', '/summary', { query: { accountId: ACC } });
  assert.deepStrictEqual(res.body, { success: true, counts: { all: 2 }, totals: { views: 3 } }); assert.deepStrictEqual(calls[0][1], { accountId: ACC });
  res = await call('get', '/summary', { query: { accountId: 'x' } }); assert.strictEqual(res.body.counts.all, 0); assert.strictEqual(res.body.totals.average_margin_percent, null, 'a store that cannot exist: zeros');
  calls.length = 0; res = await call('get', '/ids', { query: { status: 'published', q: 'a', vero: 'true', source: 'amazon' } }); assert.deepStrictEqual(res.body, { success: true, ids: ['a', 'b'] }); assert.deepStrictEqual(calls[0][1], { statuses: ['published'], accountId: null, source: 'amazon', q: 'a', vero: true });
  res = await call('get', '/ids', { query: { status: 'bogus' } }); assert.deepStrictEqual(res.body.ids, []);
  res = await call('post', '/rows', { body: { ids: [] } }); assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/rows', { body: { ids: ['a', 'b'] } }); assert.deepStrictEqual(res.body.listings, [{ id: 'a' }, { id: 'b' }]);

  // ---------- the CSV ----------
  res = await call('get', '/export', { query: { status: 'published' } });
  assert.strictEqual(res.headers['Content-Type'], 'text/csv; charset=utf-8'); assert.match(res.headers['Content-Disposition'], /live-listings\.csv/);
  const csv = res.chunks.join('');
  assert.ok(csv.startsWith('﻿"Title","SKU","Price","Qty","Category ID","Status"\r\n'), 'a byte order mark and the same columns as before');
  assert.ok(csv.includes('"A ""quoted"", title","S1","9.5","2","177","published"'), 'quotes doubled'); assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")","S2","","1","","published"`), 'a title that looks like a formula is made harmless, an empty cell is empty');
  assert.strictEqual(res.ended, true);
  calls.length = 0; res = await call('get', '/export', { query: { status: 'bogus' } }); assert.strictEqual(res.chunks.join('').split('\r\n').filter(Boolean).length, 1, 'nothing exists: only the header'); assert.strictEqual(calls.length, 0);

  // ---------- one listing: as saved, or with everything the editor needs ----------
  res = await call('get', '/:id', { params: { id: 'l1' }, query: {} }); assert.deepStrictEqual(res.body.listing, { id: 'l1', plain: true });
  calls.length = 0; res = await call('get', '/:id', { params: { id: 'l1' }, query: { full: '1' } }); assert.deepStrictEqual(res.body.listing, fullAnswer); assert.deepStrictEqual(calls[0], ['full', 'l1']);
  res = await call('get', '/:id', { params: { id: 'missing' }, query: { full: '1' } }); assert.strictEqual(res.statusCode, 404);

  console.log('listings page route tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
