// routes/cj.js: status/connect/disconnect/search/product/import all go through services/cjAdapter.js and services/
// cjImportService.js only - never an Amazon-facing service, never AMAZON_IMPORT's credit key. The real router runs; the CJ
// adapter, the import service and the credit/store checks are stand-ins.
const assert = require('assert');
const Module = require('module');

let connected = false;
const adapterCalls = [];
const fakeAdapter = {
  connect: async (userId, apiKey) => { adapterCalls.push(['connect', userId, apiKey]); if (apiKey === 'bad') throw new Error('CJdropshipping refused that key.'); connected = true; },
  disconnect: async (userId) => { adapterCalls.push(['disconnect', userId]); connected = false; },
  searchProducts: async (userId, opts) => { adapterCalls.push(['search', userId, opts]); return { total: 1, page: 1, pages: 1, products: [{ cjProductId: 'PID1', title: 'Cat Ear Hoody', image: 'i.jpg', price: 9.5, currency: 'USD' }] }; },
  getProductDetail: async (userId, opts) => {
    adapterCalls.push(['detail', userId, opts]);
    if (opts.pid === 'missing') throw Object.assign(new Error('CJdropshipping does not have that product.'), { statusCode: 404 });
    return { pid: 'PID1', productNameEn: 'Cat Ear Hoody', bigImage: 'i.jpg', description: 'D', variants: [{ vid: 'VID1', variantSku: 'SKU-BLACK', variantKey: 'Black', variantImage: null, variantSellPrice: 9.5, inventories: [{ countryCode: 'CN', totalInventory: 10 }] }] };
  },
};
const fakeImportService = { fetchAndSaveCjDraft: async (userId, ids, markup) => { adapterCalls.push(['import', userId, ids, markup]); return { importId: 'imp1', draft: { id: 'l1', sku: 'CJ-' + (ids.vid || ids.variantSku || ids.pid) } }; } };
let creditBalance = 5;
const fakeUsersModel = {
  isCjConnected: async () => ({ connected, connectedAt: connected ? new Date('2026-01-01') : null }),
  hasCredits: async (userId, n) => creditBalance >= n,
};
const fakeStore = { id: 'acc1', marketplaceId: 'EBAY_US' };
const fakeEbayAccountsModel = { getActiveEbayAccount: async () => fakeStore };
let storeOk = true;
const fakeExtensionService = { assertStoreForImport: async () => { if (!storeOk) { const e = new Error('Connect an eBay account first.'); e.statusCode = 409; throw e; } } };

const fakes = {
  '../services/cjAdapter': fakeAdapter,
  '../services/cjImportService': fakeImportService,
  '../models/usersModel': fakeUsersModel,
  '../models/ebayAccountsModel': fakeEbayAccountsModel,
  '../services/extensionService': fakeExtensionService,
};
const origLoad = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]cj\.js/.test(parent.filename)) return fakes[request]; return origLoad.apply(this, arguments); };
const router = require('../routes/cj');
Module._load = origLoad;

const handler = (method, path) => { const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); if (!l) throw new Error('no route ' + method + ' ' + path); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, path, req) => { const res = fakeRes(); await handler(method, path)({ userId: 'u1', query: {}, body: {}, params: {}, ...req }, res); return res; };

(async () => {
  // ---------- status: never the key or a token, only whether one exists ----------
  let res = await call('get', '/status');
  assert.deepStrictEqual(res.body, { success: true, connected: false, connectedAt: null });

  // ---------- connect ----------
  res = await call('post', '/connect', { body: {} });
  assert.strictEqual(res.statusCode, 400, 'an empty key is refused before it reaches CJ');
  res = await call('post', '/connect', { body: { apiKey: 'bad' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'CJdropshipping refused that key.', "CJ's own refusal reason is passed through");
  res = await call('post', '/connect', { body: { apiKey: ' good-key ' } });
  assert.deepStrictEqual(res.body, { success: true, connected: true });
  assert.deepStrictEqual(adapterCalls[adapterCalls.length - 1], ['connect', 'u1', 'good-key']);

  res = await call('get', '/status');
  assert.strictEqual(res.body.connected, true);

  // ---------- search ----------
  adapterCalls.length = 0;
  res = await call('get', '/search', { query: { keyword: 'hoodie', page: '2', size: '10' } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.products[0].cjProductId, 'PID1');
  assert.deepStrictEqual(adapterCalls[0], ['search', 'u1', { keyword: 'hoodie', categoryId: null, page: '2', size: '10' }]);

  // ---------- product detail ----------
  res = await call('get', '/product', { query: { pid: 'PID1' } });
  assert.strictEqual(res.body.product.variants[0].vid, 'VID1');
  assert.strictEqual(res.body.product.variants[0].inventory, 10);
  res = await call('get', '/product', { query: { pid: 'missing' } });
  assert.strictEqual(res.statusCode, 404);

  // ---------- import: needs an id, needs credits, needs a store, then delegates to cjImportService (never fetchAndSaveDraft, the Amazon one) ----------
  res = await call('post', '/import', { body: {} });
  assert.strictEqual(res.statusCode, 400, 'no pid/productSku/variantSku: refused before any credit check or CJ call');

  creditBalance = 0;
  res = await call('post', '/import', { body: { pid: 'PID1' } });
  assert.strictEqual(res.statusCode, 402);
  creditBalance = 5;

  storeOk = false;
  res = await call('post', '/import', { body: { pid: 'PID1' } });
  assert.strictEqual(res.statusCode, 409);
  storeOk = true;

  adapterCalls.length = 0;
  res = await call('post', '/import', { body: { pid: 'PID1', vid: 'VID1', markupPercent: 20 } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.draft.sku, 'CJ-VID1');
  const importCall = adapterCalls.find((c) => c[0] === 'import');
  assert.deepStrictEqual(importCall, ['import', 'u1', { pid: 'PID1', productSku: undefined, variantSku: undefined, vid: 'VID1' }, 20]);

  // ---------- disconnect ----------
  res = await call('post', '/disconnect');
  assert.deepStrictEqual(res.body, { success: true, connected: false });
  res = await call('get', '/status');
  assert.strictEqual(res.body.connected, false);

  console.log('cj import route tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
