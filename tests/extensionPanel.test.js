// The extension's panel on an Amazon page (POST /api/extension/check) and the extension import (POST /api/browser-import):
// credits, the user's stores, what is already imported, VeRO words; a store chosen in the extension; no credit spent on a product
// that cannot be imported.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const U1 = '1'.repeat(24);
const ADMIN = '9'.repeat(24);
const UK = 'a'.repeat(24);
const US = 'b'.repeat(24);
const OTHER_USERS_STORE = 'c'.repeat(24);

const db = { users: {}, listings: [], veroWords: [], spent: [], refunded: [], imports: [], drafts: [] };
const accounts = [
  { id: UK, label: 'Trendy UK', marketplaceId: 'EBAY_GB', isActive: true },
  { id: US, label: 'US shop', marketplaceId: 'EBAY_US', isActive: false },
];
const listing = (over) => ({ id: 'L' + (db.listings.length + 1), sku: 'B0TEST0001', status: 'draft', ebay_account_id: UK, sell_price: 12.99, amazon_price: 8, currency: 'GBP', ebay_listing_id: null, updated_at: new Date('2026-03-01'), ...over });

stub('models/usersModel', {
  getUserById: async (id) => (db.users[id] ? { id, ...db.users[id] } : null),
  hasCredits: async (id, n) => db.users[id].role === 'admin' || db.users[id].creditBalance >= n,
  spendCredit: async (id, n) => { if (db.users[id].role !== 'admin' && db.users[id].creditBalance < n) return false; if (db.users[id].role !== 'admin') db.users[id].creditBalance -= n; db.spent.push(n); return true; },
  refundCredit: async (id, n) => { db.users[id].creditBalance += n; db.refunded.push(n); },
});
stub('models/ebayAccountsModel', {
  listEbayAccounts: async () => accounts,
  getActiveEbayAccount: async () => accounts.find((a) => a.isActive) || null,
  getEbayAccountById: async (userId, id) => accounts.find((a) => a.id === id) || null,
});
stub('models/listingsModel', {
  listListingsBySku: async (userId, sku) => db.listings.filter((l) => l.sku === sku),
  findListingInStore: async (userId, sku, storeId) => db.listings.find((l) => l.sku === sku && (l.ebay_account_id === storeId || l.ebay_account_id === null)) || null,
  upsertDraft: async (userId, fields) => { db.drafts.push(fields); return { id: 'D1', status: 'draft', sku: fields.sku }; },
});
stub('models/importsModel', {
  createImport: async (userId, product, price, url, storeId) => { db.imports.push({ product, price, url, storeId }); return { id: 'IMP1' }; },
  updateImportImages: async () => {},
});
stub('services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls });
stub('services/veroSettingsService', { getVeroWordsOf: async () => db.veroWords });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const extension = require('../services/extensionService');
const extensionRoutes = require('../routes/extension');
const importRoutes = require('../routes/browserImport');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, p, req) => { const res = fakeRes(); await handler(router, 'post', p)({ userId: U1, body: {}, headers: {}, ...req }, res); return res; };
const reset = () => {
  db.users = { [U1]: { role: 'user', creditBalance: 40 }, [ADMIN]: { role: 'admin', creditBalance: 0 } };
  db.listings = []; db.veroWords = []; db.spent = []; db.refunded = []; db.imports = []; db.drafts = [];
};

const PAGE_URL = 'https://www.amazon.co.uk/dp/B0TEST0001';
const PRODUCT = { asin: 'B0TEST0001', title: 'Plain Widget', price: 8, images: [], bulletPoints: ['Nice widget'] };

(async () => {
  // ---------- the panel ----------
  reset();
  let info = await extension.panelInfo({ userId: U1, asin: 'b0test0001', amazonUrl: PAGE_URL, title: 'Plain Widget', brand: 'Acme', bulletPoints: [] });
  assert.deepStrictEqual(info.credits, { balance: 40, unlimited: false, importCost: 1, bulkImportCost: 1 });
  assert.strictEqual(info.stores.length, 2);
  assert.deepStrictEqual(info.stores.map((s) => [s.id, s.amazonOk, s.currency, s.isActive]), [[UK, true, 'GBP', true], [US, false, 'USD', false]], 'the UK store takes amazon.co.uk, the US store does not');
  assert.ok(/amazon\.com/.test(info.stores[1].amazonMessage), 'the message says which site the store needs');
  assert.deepStrictEqual(info.existing, []);
  assert.deepStrictEqual(info.vero, { enabled: false, terms: [], fields: {} }, 'no words saved: nothing is flagged');
  assert.strictEqual(info.appUrl, 'https://elmstool.com');

  db.users[ADMIN].role = 'admin';
  info = await extension.panelInfo({ userId: ADMIN, asin: 'B0TEST0001', amazonUrl: PAGE_URL });
  assert.deepStrictEqual([info.credits.unlimited, info.credits.balance], [true, null], 'an admin has no limit');

  // what the user already has for this ASIN, in any store
  db.listings.push(listing({ id: 'L1', status: 'draft', ebay_account_id: UK }), listing({ id: 'L2', status: 'published', ebay_account_id: US, sell_price: 19.5, amazon_price: 11, currency: 'USD', ebay_listing_id: '123' }), listing({ id: 'L3', sku: 'B0OTHER001' }));
  info = await extension.panelInfo({ userId: U1, asin: 'B0TEST0001', amazonUrl: PAGE_URL });
  assert.deepStrictEqual(info.existing.map((e) => [e.id, e.status, e.storeId, e.storeLabel, e.sellPrice, e.amazonPrice, e.currency]), [
    ['L1', 'draft', UK, 'Trendy UK', 12.99, 8, 'GBP'],
    ['L2', 'published', US, 'US shop', 19.5, 11, 'USD'],
  ], 'only this ASIN, with the store named');

  // VeRO words: the user's own list, in the title / brand / bullet points
  db.veroWords = ['nike', 'acme'];
  info = await extension.panelInfo({ userId: U1, asin: 'B0TEST0001', amazonUrl: PAGE_URL, title: 'NIKE-style widget', brand: 'Acme', bulletPoints: ['Fits nike shoes'] });
  assert.strictEqual(info.vero.enabled, true);
  assert.deepStrictEqual([...info.vero.terms].sort(), ['acme', 'nike']);
  assert.deepStrictEqual(Object.keys(info.vero.fields).sort(), ['brand', 'bulletPoints', 'title']);
  info = await extension.panelInfo({ userId: U1, asin: 'B0TEST0001', amazonUrl: PAGE_URL, title: 'Plain Widget' });
  assert.deepStrictEqual(info.vero.terms, [], 'a clean product: nothing found');

  // no ASIN (the popup): credits and stores only
  info = await extension.panelInfo({ userId: U1 });
  assert.strictEqual(info.stores.every((s) => s.amazonOk), true, 'no page: every store is fine');
  assert.deepStrictEqual([info.existing, info.vero.terms], [[], []]);
  info = await extension.panelInfo({ userId: U1, asin: 'not-an-asin' });
  assert.deepStrictEqual(info.existing, [], 'something that is not an ASIN finds nothing');
  assert.strictEqual(await extension.panelInfo({ userId: 'ghost' }), null, 'an unknown user');

  // ---------- the route ----------
  reset();
  let res = await call(extensionRoutes, '/check', { body: { asin: 'B0TEST0001', amazonUrl: PAGE_URL, title: 'Plain Widget', bulletPoints: 'not a list' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.credits.balance, 40);
  assert.strictEqual(res.body.stores.length, 2);
  res = await call(extensionRoutes, '/check', { userId: 'ghost', body: {} });
  assert.strictEqual(res.statusCode, 404);

  // ---------- the import ----------
  const importBody = (over = {}) => ({ amazonUrl: PAGE_URL, product: PRODUCT, markupPercent: 60, ...over });

  // the active store, no store chosen
  reset();
  res = await call(importRoutes, '/', { body: importBody() });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.drafts[0].ebayAccountId, UK, 'no store chosen: the active one');
  assert.deepStrictEqual(db.spent, [1]);
  assert.strictEqual(res.body.creditsLeft, 39, 'what is left after the import');
  assert.deepStrictEqual(res.body.store, { id: UK, label: 'Trendy UK' });
  assert.strictEqual(res.body.appUrl, 'https://elmstool.com');
  assert.strictEqual(res.body.draft.id, 'D1');

  // an admin: no limit, no number
  reset();
  res = await call(importRoutes, '/', { userId: ADMIN, body: importBody() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.creditsLeft, null);

  // a store chosen in the extension
  reset();
  res = await call(importRoutes, '/', { body: importBody({ amazonUrl: 'https://www.amazon.com/dp/B0TEST0001', ebayAccountId: US }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.drafts[0].ebayAccountId, US, 'the chosen store, not the active one');
  assert.strictEqual(db.imports[0].storeId, US);

  // the chosen store must fit the Amazon site: nothing is charged
  reset();
  res = await call(importRoutes, '/', { body: importBody({ ebayAccountId: US }) });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/amazon\.com/.test(res.body.error));
  assert.deepStrictEqual([db.spent, db.drafts.length], [[], 0]);

  // a store that is not the user's (or not a store at all)
  reset();
  for (const bad of [OTHER_USERS_STORE, 'not-an-id', '<script>']) {
    res = await call(importRoutes, '/', { body: importBody({ ebayAccountId: bad }) });
    assert.strictEqual(res.statusCode, 404, bad);
    assert.ok(/not found/.test(res.body.error));
  }
  assert.deepStrictEqual([db.spent, db.drafts.length], [[], 0], 'no credit spent, nothing saved');

  // already live in this store: not imported, not charged
  reset();
  db.listings.push(listing({ status: 'published', ebay_account_id: UK, ebay_listing_id: '555' }));
  res = await call(importRoutes, '/', { body: importBody() });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'already_listed');
  assert.strictEqual(res.body.error, 'This product is already live on eBay in Trendy UK. Nothing was imported and no credit was used.');
  assert.deepStrictEqual([db.spent, db.imports.length, db.drafts.length], [[], 0, 0]);

  // every state that is not a draft says what it is
  for (const [status, words] of [['paused', 'on eBay (paused)'], ['publishing', 'being published right now'], ['scheduled', 'scheduled to publish'], ['error', 'Retry'], ['ended', 'Live Listings']]) {
    reset();
    db.listings.push(listing({ status }));
    res = await call(importRoutes, '/', { body: importBody() });
    assert.strictEqual(res.statusCode, 409, status);
    assert.ok(res.body.error.includes(words), status + ': ' + res.body.error);
  }

  // live in ANOTHER store only: this store can still import
  reset();
  db.listings.push(listing({ status: 'published', ebay_account_id: US }));
  res = await call(importRoutes, '/', { body: importBody() });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

  // a draft is refreshed (and charged, as before)
  reset();
  db.listings.push(listing({ status: 'draft', ebay_account_id: UK }));
  res = await call(importRoutes, '/', { body: importBody() });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.spent, [1]);

  // no credits: nothing is saved
  reset();
  db.users[U1].creditBalance = 0;
  res = await call(importRoutes, '/', { body: importBody() });
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(db.drafts.length, 0);

  assert.strictEqual(importRoutes.alreadyListedMessage({ status: 'draft' }, { label: 'X' }), null);
  assert.strictEqual(importRoutes.alreadyListedMessage(null, null), null);
  assert.strictEqual(importRoutes.alreadyListedMessage({ status: 'published' }, null), 'This product is already live on eBay. Nothing was imported and no credit was used.');

  console.log('extension panel tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
