// The Live listings page loads ONE PAGE at a time: the database searches, filters, sorts and counts; a row carries only what the list shows (no description,
// bullets, specifications, item specifics or all pictures); orders are counted only for the listings of the page; the store-less listings are looked for only when
// there are some; VeRO words are flagged on the server; the summary, the ids of "Select all", the rows of chosen ids, the full row of the listing being edited and
// the CSV file come from the server too. The real model runs with an in-memory database.
const assert = require('assert');
const Module = require('module');

const USER = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const OTHER = 'ffffffffffffffffffffffff';
const hex = (n) => n.toString(16).padStart(24, '0');
const ACC1 = '0123456789abcdef01234567'; const ACC2 = '0123456789abcdef01234568';

// ---------------- an in-memory database ----------------
const listings = []; const imports = new Map(); const accounts = new Map(); const orders = [];
const seen = { finds: [], selects: [], populates: [], leans: 0, sortKeys: [], exists: 0, orphanReads: 0, aggMatches: [], updates: [] };
const sortKey = (v) => (v === null || v === undefined ? -Infinity : v instanceof Date ? v.getTime() : v);
function matches(doc, q) {
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === '$or') { if (!v.some((c) => matches(doc, c))) return false; continue; }
    if (k === '$and') { if (!v.every((c) => matches(doc, c))) return false; continue; }
    const val = doc[k];
    if (v instanceof RegExp) { if (!v.test(String(val ?? ''))) return false; continue; }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) { if (!v.$in.map(String).includes(String(val))) return false; continue; }
      if ('$lt' in v) { if (!(String(val) < String(v.$lt))) return false; continue; }
      continue;
    }
    if (v === null) { if (val !== null && val !== undefined) return false; continue; }
    if (String(val) !== String(v)) return false;
  }
  return true;
}
function project(doc, fields) {
  if (!fields) return { ...doc };
  const names = String(fields).split(/\s+/).filter(Boolean);
  if (names.length && names.every((f) => f.startsWith('-'))) { const all = { ...doc }; names.forEach((f) => delete all[f.slice(1)]); return all; } // only exclusions: everything else stays
  const out = { _id: doc._id };
  for (const f of String(fields).split(/\s+/).filter(Boolean)) {
    if (f.startsWith('-')) continue;
    const [head, ...rest] = f.split('.');
    if (!(head in doc)) continue;
    if (rest.length) { out[head] = { ...(out[head] || {}) }; out[head][rest[0]] = doc[head][rest[0]]; } else out[head] = doc[head];
  }
  return out;
}
function chain(rows, store) {
  const st = { fields: null, sort: null, skip: 0, limit: Infinity, pops: [] };
  const run = () => {
    let out = rows.slice();
    if (st.sort) { const keys = Object.entries(st.sort); out.sort((a, b) => { for (const [k, dir] of keys) { const x = sortKey(a[k]); const y = sortKey(b[k]); if (x < y) return -dir; if (x > y) return dir; } return 0; }); }
    out = out.slice(st.skip, st.skip + st.limit).map((d) => project(d, st.fields));
    for (const p of st.pops) out = out.map((d) => { const src = p.path === 'importId' ? imports : accounts; const target = src.get(String(d[p.path])); return target ? { ...d, [p.path]: project(target, p.select) } : d; });
    return out;
  };
  const c = {
    select: (f) => { st.fields = f; seen.selects.push(f); return c; },
    populate: (p) => { st.pops.push(p); seen.populates.push(p); return c; },
    sort: (s) => { st.sort = s; seen.sortKeys.push(Object.keys(s).join(',')); return c; },
    skip: (n) => { st.skip = n; return c; },
    limit: (n) => { st.limit = n; return c; },
    lean: () => { seen.leans += 1; const p = Promise.resolve(run()); p.cursor = c.cursor; return p; }, // a query, like Mongoose's: awaited, or turned into a cursor
    cursor: () => ({ [Symbol.asyncIterator]: async function* () { for (const d of run()) yield d; } }),
  };
  return c;
}
const Listing = {
  find: (q) => { seen.finds.push(q); if (q && q.ebayAccountId === null && q.userId && !q.status) seen.orphanReads += 1; return chain(listings.filter((d) => matches(d, q)), listings); },
  countDocuments: async (q) => listings.filter((d) => matches(d, q)).length,
  exists: async (q) => { seen.exists += 1; return listings.some((d) => matches(d, q)) ? { _id: 1 } : null; },
  findOne: (q) => { const c = chain(listings.filter((d) => matches(d, q)).slice(0, 1), listings); const lean = c.lean; c.lean = async () => (await lean())[0] || null; return c; },
  updateOne: async (q, u) => { seen.updates.push([q, u]); const d = listings.find((x) => matches(x, q)); if (d) Object.assign(d, u.$set); },
};
const fakes = {
  './schemas/Listing': Listing,
  './schemas/Import': { find: (q) => chain([...imports.values()].filter((d) => matches(d, q)), imports) },
  './schemas/EbayAccount': { find: (q) => chain([...accounts.values()].filter((d) => matches(d, q)), accounts) },
  './schemas/Order': { aggregate: async (pipeline) => {
    const m = pipeline[0].$match; seen.aggMatches.push(m);
    const inList = m.listingId && m.listingId.$in ? m.listingId.$in.map(String) : null;
    const sums = new Map();
    for (const o of orders) { if (inList && !inList.includes(String(o.listingId))) continue; sums.set(String(o.listingId), (sums.get(String(o.listingId)) || 0) + (o.quantity ?? 1)); }
    return [...sums.entries()].map(([id, sold]) => ({ _id: id, sold }));
  } },
  '../services/veroSettingsService': { getVeroWordsOf: async () => veroWords },
};
let veroWords = [];
const orig = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /listingsModel\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
const M = require('../models/listingsModel');

const reset = () => { listings.length = 0; imports.clear(); accounts.clear(); orders.length = 0; Object.assign(seen, { finds: [], selects: [], populates: [], leans: 0, sortKeys: [], exists: 0, orphanReads: 0, aggMatches: [], updates: [] }); veroWords = []; M._resetClaimMemory && M._resetClaimMemory(); };
let n = 0;
const add = (over = {}) => { n += 1; const d = { _id: hex(n), userId: USER, importId: null, ebayAccountId: ACC1, sku: 'B0' + String(n).padStart(8, '0'), title: 'Product ' + n, mainImage: 'https://img/' + n + '.jpg', images: ['a', 'b', 'c'], sellPrice: 20, amazonPrice: 10, status: 'published', currency: 'GBP', quantity: 5, description: 'A long description ' + n, bulletPoints: ['b1', 'b2'], specifications: [{ name: 'x', value: 'y' }], ebayAspects: { Brand: ['Acme'] }, ebayListingId: '11000' + n, categoryId: '177', note: '', views: n, watchers: 0, createdAt: new Date(2026, 0, 1, 0, n), updatedAt: new Date(2026, 5, 1), markupPercent: 10, publishResponse: { big: 'x' }, ...over }; listings.push(d); return d; };

(async () => {
  // ---------- page and limit ----------
  assert.deepStrictEqual(M.pageOptions({}), { page: 1, limit: 50 }, 'page 1, 50 a page');
  assert.deepStrictEqual(M.pageOptions({ page: '3', limit: '20' }), { page: 3, limit: 20 });
  assert.deepStrictEqual(M.pageOptions({ page: '-4', limit: '9999' }), { page: 1, limit: 200 }); assert.deepStrictEqual(M.pageOptions({ page: 'x', limit: '0' }), { page: 1, limit: 50 });
  assert.ok(M.pageQuery(USER, { q: 'a.b(c)' }).$or[0].title.test('xx A.B(C) yy') && !M.pageQuery(USER, { q: 'a.b(c)' }).$or[0].title.test('aXb(c)'), 'the search text is text, not a pattern');
  assert.deepStrictEqual(Object.keys(M.pageQuery(USER, { statuses: ['published'], accountId: ACC1 })).sort(), ['ebayAccountId', 'status', 'userId']);

  // ---------- a page: 120 live listings, 50 to a page ----------
  reset();
  for (let i = 0; i < 120; i += 1) add({ importId: i % 2 ? hex(9000 + i) : null, amazonPrice: i % 2 ? null : 10 });
  add({ status: 'draft' }); add({ userId: OTHER }); // not this seller's live listings
  for (let i = 0; i < 120; i += 1) if (i % 2) imports.set(hex(9000 + i), { _id: hex(9000 + i), asin: 'B0IMPORT' + i, amazonUrl: 'https://www.amazon.co.uk/dp/B0IMPORT' + i, amazonPrice: 12, product: { price: 12, description: 'IMPORT DESCRIPTION', images: ['i'] }, aplusContent: 'x' });
  accounts.set(ACC1, { _id: ACC1, displayName: 'Trendy UK', ebayUserId: 'trendy_uk', storeNumber: 1, refreshTokenEncrypted: 'SECRET' });
  const target = listings.find((d) => d.sku.endsWith('00000005')); orders.push({ listingId: target._id, quantity: 2 }, { listingId: target._id, quantity: 1 }, { listingId: hex(999), quantity: 7 });
  let out = await M.listListingsPage(USER, { statuses: ['published'] });
  assert.deepStrictEqual([out.listings.length, out.total, out.page, out.limit, out.pages], [50, 120, 1, 50, 3], 'the first 50 of 120');
  assert.deepStrictEqual(out.listings.slice(0, 2).map((r) => r.title), ['Product 120', 'Product 119'], 'newest first');
  const r0 = out.listings[0];
  for (const k of ['description', 'bullet_points', 'specifications', 'ebay_aspects', 'images', 'publish_response', 'ebay_image_urls', 'tags']) assert.ok(!(k in r0), k + ' is not sent in the list');
  for (const k of ['id', 'title', 'main_image', 'sell_price', 'amazon_price', 'status', 'sku', 'asin', 'sold_count', 'views', 'watchers', 'updated_at', 'ebay_account_label', 'ebay_listing_id', 'marketplace_id', 'currency', 'quantity', 'note', 'created_at', 'pricing_rule', 'markup_percent', 'amazon_url']) assert.ok(k in r0, k + ' is in a row');
  assert.strictEqual(r0.ebay_account_label, 'Trendy UK'); assert.ok(!JSON.stringify(out.listings).includes('SECRET') && !JSON.stringify(out.listings).includes('IMPORT DESCRIPTION'), "no token, no import description");
  const imported = out.listings.find((r) => r.asin); assert.deepStrictEqual([imported.amazon_price, imported.amazon_url.startsWith('https://www.amazon.co.uk'), imported.supplier_country], [12, true, 'UK'], "the import's price when the listing has none");
  // the database is asked for the little the list needs, as plain objects
  const pageSelect = seen.selects.find((s) => /sellPrice/.test(s) && /title/.test(s));
  assert.ok(pageSelect && !/description|bulletPoints|specifications|ebayAspects|publishResponse|images\b/.test(pageSelect), 'no heavy field is read for the page (no VeRO words: nothing to scan)');
  const imp = seen.populates.find((p) => p.path === 'importId'); assert.strictEqual(imp.select, 'asin amazonUrl amazonPrice product.price', 'from the import: only the link, the ASIN and the prices');
  assert.ok(seen.leans >= 2, 'plain objects (lean)');
  // orders are counted only for the listings of this page
  const agg = seen.aggMatches[seen.aggMatches.length - 1]; assert.strictEqual(agg.listingId.$in.length, 50, 'the sold count reads 50 listings, not all');
  out = await M.listListingsPage(USER, { statuses: ['published'], page: 3, limit: 50 });
  assert.deepStrictEqual([out.listings.length, out.page], [20, 3], 'the last page'); assert.strictEqual(out.listings.find((r) => r.id === target._id).sold_count, 3, 'units sold: 2 + 1');
  out = await M.listListingsPage(USER, { statuses: ['published'], page: 9 }); assert.deepStrictEqual([out.listings.length, out.total, out.pages], [0, 120, 3], 'beyond the last page: nothing, but the total');
  out = await M.listListingsPage(USER, { statuses: ['published'], limit: 12, page: 2 }); assert.deepStrictEqual([out.listings.length, out.pages, out.listings[0].title], [12, 10, 'Product 108']);

  // ---------- search and status ----------
  out = await M.listListingsPage(USER, { statuses: ['published'], q: 'product 11' }); assert.strictEqual(out.total, 11, '"Product 11", "Product 110".."Product 119"');
  out = await M.listListingsPage(USER, { statuses: ['published'], q: listings[4].sku.toLowerCase() }); assert.deepStrictEqual([out.total, out.listings[0].sku], [1, listings[4].sku], 'the SKU, in any case');
  out = await M.listListingsPage(USER, { statuses: ['published'], q: '110007' }); assert.ok(out.total >= 1 && out.listings.every((r) => /110007/.test(r.ebay_listing_id)), 'the eBay item number');
  listings[10].note = 'call the supplier'; out = await M.listListingsPage(USER, { statuses: ['published'], q: 'SUPPLIER' }); assert.strictEqual(out.total, 1, 'the private note');
  assert.strictEqual((await M.listListingsPage(USER, { statuses: ['draft'] })).total, 1, 'the status filter'); assert.strictEqual((await M.listListingsPage(USER, { statuses: ['ended'] })).total, 0);
  assert.strictEqual((await M.listListingsPage(USER, {})).total, 121, 'no status: all of the seller\'s listings (the other seller\'s is never in it)');
  add({ ebayAccountId: ACC2, title: 'Other store item' }); assert.strictEqual((await M.listListingsPage(USER, { statuses: ['published'], accountId: ACC2 })).total, 1, 'one store');

  // ---------- the source filter (Amazon vs CJdropshipping) ----------
  reset();
  add({ title: 'Amazon one', sourcePlatform: 'amazon' });
  add({ title: 'Amazon two', sourcePlatform: 'amazon' });
  add({ title: 'CJ one', sourcePlatform: 'cj', cjProductId: 'PID1', cjVariantId: 'VID1' });
  out = await M.listListingsPage(USER, { statuses: ['published'], source: 'amazon' });
  assert.deepStrictEqual([out.total, out.listings.map((r) => r.title).sort()], [2, ['Amazon one', 'Amazon two']], 'source=amazon: only the Amazon listings');
  out = await M.listListingsPage(USER, { statuses: ['published'], source: 'cj' });
  assert.deepStrictEqual([out.total, out.listings[0].title], [1, 'CJ one'], 'source=cj: only the CJ listing');
  out = await M.listListingsPage(USER, { statuses: ['published'] });
  assert.strictEqual(out.total, 3, 'no source filter: every source');
  assert.strictEqual((await M.listListingIds(USER, { statuses: ['published'], source: 'cj' })).length, 1, 'listListingIds respects the source filter too');

  // ---------- sorting ----------
  reset();
  const A = add({ title: 'A', sellPrice: 50, amazonPrice: 10, views: 5, watchers: 9, createdAt: new Date(2026, 1, 1) });
  const B = add({ title: 'B', sellPrice: 30, amazonPrice: 5, views: 50, watchers: 1, createdAt: new Date(2026, 2, 1) });
  const C = add({ title: 'C', sellPrice: 40, amazonPrice: null, views: null, watchers: 3, createdAt: new Date(2026, 0, 1) }); // no cost
  const D = add({ title: 'D', sellPrice: 100, amazonPrice: 20, pricingRule: { feePercent: 50, feeFixed: 1, shipping: 4 }, views: 1, watchers: 0, createdAt: new Date(2026, 3, 1) }); // profit 100 - 24 - 51 = 25 after fees
  orders.push({ listingId: A._id, quantity: 4 }, { listingId: B._id, quantity: 9 }, { listingId: D._id, quantity: 2 });
  const titles = async (sort) => (await M.listListingsPage(USER, { statuses: ['published'], sort })).listings.map((r) => r.title).join('');
  assert.strictEqual(await titles('newest'), 'DBAC'); assert.strictEqual(await titles('price'), 'DACB'); assert.strictEqual(await titles('priceLow'), 'BCAD');
  assert.strictEqual(await titles('views'), 'BADC', 'a listing with no views is last'); assert.strictEqual(await titles('watchers'), 'ACBD');
  assert.strictEqual(await titles('profit'), 'ADBC', "A 40, then D and B with 25 each (D after the Margin rule's fees; a tie goes to the newer one); the one with no cost is last");
  assert.strictEqual(await titles('profitLow'), 'DBAC', 'lowest first, the one with no cost still last');
  assert.strictEqual(await titles('sold'), 'BADC', 'units sold, from the orders');
  assert.strictEqual(await titles('nonsense'), 'DBAC', 'an unknown sort is "newest"');
  out = await M.listListingsPage(USER, { statuses: ['published'], sort: 'profit', limit: 2, page: 2 }); assert.deepStrictEqual(out.listings.map((r) => r.title), ['B', 'C'], 'the page is cut out of the sorted list');

  // ---------- the store-less listings are looked for only when there are some ----------
  reset();
  add(); add();
  seen.exists = 0; await M.listListingsPage(USER, { statuses: ['published'], accountId: ACC1 });
  assert.deepStrictEqual([seen.exists, seen.orphanReads], [1, 0], 'one cheap check, no reading of listings');
  await M.listListingsPage(USER, { statuses: ['published'], accountId: ACC1 }); assert.strictEqual(seen.exists, 1, 'a seller with none is not asked again for ten minutes');
  await M.listListingsPage(USER, { statuses: ['published'] }); assert.strictEqual(seen.exists, 1, 'no store in the request: nothing to give');
  reset(); accounts.set(ACC1, { _id: ACC1, userId: USER, marketplaceId: 'EBAY_GB', createdAt: new Date(1) });
  const orphan = add({ ebayAccountId: null }); seen.exists = 0;
  await M.listListingsPage(USER, { statuses: ['published'], accountId: ACC1 });
  assert.strictEqual(seen.orphanReads, 1, 'found one: given a home once'); assert.strictEqual(String(orphan.ebayAccountId), ACC1);
  await M.claimAfterStoreConnected(USER, ACC2); // a new store is connected: looked at again at once (nothing left, no error)

  // ---------- VeRO words ----------
  reset();
  const V1 = add({ title: 'Nice lamp', description: 'A genuine Acme product', ebayAspects: {} }); add({ title: 'Plain lamp', ebayAspects: {} }); const V3 = add({ title: 'Acme lamp', ebayAspects: {} });
  for (let i = 0; i < 4; i += 1) add({ ebayAspects: {} });
  out = await M.listListingsPage(USER, { statuses: ['published'] }); assert.ok(out.listings.every((r) => Array.isArray(r.vero_terms) && !r.vero_terms.length), 'no VeRO words: nothing is flagged');
  veroWords = ['Acme'];
  out = await M.listListingsPage(USER, { statuses: ['published'], sort: 'newest' });
  assert.deepStrictEqual(out.listings.filter((r) => r.vero_terms.length).map((r) => r.id).sort(), [V1._id, V3._id].sort(), 'the words are looked for in the title and the description (and the bullets, specifications, item specifics)');
  assert.ok(!('description' in out.listings[0]), 'the text that was scanned is not sent');
  // only the ones with a word: the whole list is searched (not just a page), each row says which word
  M.clearVeroCache(USER); veroWords = ['lamp'];
  out = await M.listListingsPage(USER, { statuses: ['published'], vero: true, limit: 2 });
  assert.deepStrictEqual([out.total, out.listings.length, out.pages], [3, 2, 2]); assert.deepStrictEqual(out.listings[0].vero_terms, ['lamp']);
  out = await M.listListingsPage(USER, { statuses: ['published'], vero: true, q: 'plain' }); assert.deepStrictEqual([out.total, out.listings[0].title], [1, 'Plain lamp'], 'search and VeRO together');
  assert.deepStrictEqual((await M.listListingIds(USER, { statuses: ['published'], vero: true })).length, 3);
  veroWords = []; M.clearVeroCache(USER); assert.strictEqual((await M.listListingsPage(USER, { statuses: ['published'], vero: true })).total, 0, 'no words: no VeRO listing');

  // ---------- the summary above the list ----------
  reset();
  const S1 = add({ sellPrice: 20, amazonPrice: 10, views: 10, watchers: 2, statsSyncedAt: new Date('2026-09-20T10:00:00Z') });
  const S2 = add({ sellPrice: 40, amazonPrice: null, importId: hex(7001), views: 5, watchers: 3, statsSyncedAt: new Date('2026-09-25T10:00:00Z') });
  const S3 = add({ status: 'sold', quantity: 1, soldQuantity: 1, sellPrice: 30, amazonPrice: 15, views: 7, watchers: 1, statsSyncedAt: new Date('2026-09-22T10:00:00Z') });
  add({ sellPrice: 15, amazonPrice: null, views: null, watchers: null }); add({ status: 'ended' }); add({ status: 'draft' }); add({ userId: OTHER });
  imports.set(hex(7001), { _id: hex(7001), amazonPrice: 30, product: { price: 30 } });
  orders.push({ listingId: S1._id, quantity: 3 }, { listingId: S2._id, quantity: 1 }, { listingId: S3._id, quantity: 2 }, { listingId: hex(4242), quantity: 50 });
  const sum = await M.summarizeLiveListings(USER, {});
  assert.deepStrictEqual(sum.counts, { all: 4, active: 3, sold: 1, ended: 1, issues: 0, vero: 0 }, 'a sold-out listing is its own count, out of active, but still counted in "all"');
  assert.deepStrictEqual(sum.totals, { units_sold: 6, views: 22, watchers: 6, average_margin_percent: 42, last_synced_at: '2026-09-25T10:00:00.000Z' }, 'margins: 50%, 25%, 50% -> 42%; units sold (and views/watchers) include the sold-out listing too');

  // ---------- ids, rows of chosen ids, the full row ----------
  const ids = await M.listListingIds(USER, { statuses: ['published'] }); assert.strictEqual(ids.length, 3);
  const rows = await M.listRowsByIds(USER, [S2._id, 'not-an-id', S1._id, hex(31337)]); assert.deepStrictEqual(rows.map((r) => r.id), [S2._id, S1._id], 'in the order asked; a bad id or another seller\'s listing is left out');
  assert.strictEqual(rows[0].amazon_price, 30);
  const bare = add({ description: '', bulletPoints: [], specifications: [], ebayAspects: {}, images: [], importId: hex(7002), title: 'Full one' });
  imports.set(hex(7002), { _id: hex(7002), asin: 'B0FULL', amazonUrl: 'https://www.amazon.com/dp/B0FULL', product: { asin: 'B0FULL', price: 9, brand: 'Acme', description: 'FROM THE IMPORT', bulletPoints: ['x'], images: ['https://i/1.jpg'], variants: [] } });
  const full = await M.getListingFull(USER, bare._id);
  assert.deepStrictEqual([full.description, full.brand, full.images], ['FROM THE IMPORT', 'Acme', ['https://i/1.jpg']], 'the editor gets what the list no longer carries, with the import as the fallback');
  assert.strictEqual(await M.getListingFull(USER, 'nope'), null); assert.strictEqual(await M.getListingFull(OTHER, bare._id), null, 'only the seller\'s own');

  // ---------- the CSV: a thousand at a time ----------
  reset(); for (let i = 0; i < 2500; i += 1) add();
  const sizes = []; let first = null;
  await M.eachListingChunk(USER, { statuses: ['published'] }, async (chunk) => { sizes.push(chunk.length); if (!first) first = chunk[0]; });
  assert.deepStrictEqual(sizes, [1000, 1000, 500], 'never all of them in memory'); assert.strictEqual(first.title, listings[listings.length - 1].title, 'newest first');
  assert.deepStrictEqual(Object.keys(first), ['title', 'sku', 'sell_price', 'quantity', 'category_id', 'status']);

  Module._load = orig;
  console.log('listings page tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
