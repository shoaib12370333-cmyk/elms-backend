// routes/aliexpress.js: /product and /import go through services/aliexpressAdapter.js and services/
// aliexpressImportService.js only - never an Amazon-facing or CJ-facing service, never AMAZON_IMPORT/CJ_IMPORT's credit key.
// The real router runs; the adapter, the import service and the credit/store checks are stand-ins.
const assert = require('assert');
const Module = require('module');

const adapterCalls = [];
const fakeAdapter = {
  getProductDetail: async (userId, opts) => {
    adapterCalls.push(['detail', userId, opts]);
    if (opts.productId === '9999999999') throw Object.assign(new Error('AliExpress does not have that product.'), { statusCode: 404 });
    return {
      ae_item_base_info_dto: { subject: 'Sunglasses', product_id: opts.productId },
      ae_multimedia_info_dto: { image_urls: 'https://img/1.jpg;https://img/2.jpg' },
      ae_item_sku_info_dtos: [{ sku_id: 'S1', offer_sale_price: '9.99', sku_available_stock: '5', ae_sku_property_dtos: [{ property_value_definition_name: 'Black' }] }],
    };
  },
};
const fakeImportService = {
  extractAliexpressProductId: (v) => { const m = String(v || '').match(/(\d{5,})/); return m ? m[1] : null; },
  destCountryFor: () => 'US',
  listSkus: (detail) => (detail.ae_item_sku_info_dtos || []).map((s) => ({ skuId: s.sku_id, label: 'Black', price: 9.99, inventory: 5 })),
  fetchAndSaveAliexpressDraft: async (userId, ids, markup) => { adapterCalls.push(['import', userId, ids, markup]); return { importId: 'imp1', draft: { id: 'l1', sku: 'AE-' + ids.skuId } }; },
};
let creditBalance = 5;
const fakeUsersModel = { hasCredits: async (userId, n) => creditBalance >= n };
const fakeStore = { id: 'acc1', marketplaceId: 'EBAY_US' };
const fakeEbayAccountsModel = { getActiveEbayAccount: async () => fakeStore };
let storeOk = true;
const fakeExtensionService = { assertStoreForImport: async () => { if (!storeOk) { const e = new Error('Connect an eBay account first.'); e.statusCode = 409; throw e; } } };

const fakes = {
  '../services/aliexpressAdapter': fakeAdapter,
  '../services/aliexpressImportService': fakeImportService,
  '../models/usersModel': fakeUsersModel,
  '../models/ebayAccountsModel': fakeEbayAccountsModel,
  '../services/extensionService': fakeExtensionService,
};
const origLoad = Module._load;
Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]aliexpress\.js/.test(parent.filename)) return fakes[request]; return origLoad.apply(this, arguments); };
const router = require('../routes/aliexpress');
Module._load = origLoad;

const handler = (method, path) => { const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); if (!l) throw new Error('no route ' + method + ' ' + path); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, path, req) => { const res = fakeRes(); await handler(method, path)({ userId: 'u1', query: {}, body: {}, params: {}, ...req }, res); return res; };

(async () => {
  // ---------- product detail: url or id both work, resolves through extractAliexpressProductId ----------
  let res = await call('get', '/product', { query: { url: 'https://www.aliexpress.com/item/1005003784285827.html' } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.product.title, 'Sunglasses');
  assert.strictEqual(res.body.product.skus[0].skuId, 'S1');
  assert.deepStrictEqual(adapterCalls[0], ['detail', 'u1', { productId: '1005003784285827', shipToCountry: 'US' }]);

  res = await call('get', '/product', { query: { productId: '9999999999' } });
  assert.strictEqual(res.statusCode, 404);

  res = await call('get', '/product', { query: { url: 'not a link' } });
  assert.strictEqual(res.statusCode, 400, 'no id found in the input: refused before any AliExpress call');

  // ---------- import: needs an id, needs credits, needs a store, then delegates to aliexpressImportService (never fetchAndSaveCjDraft/Amazon's fetchAndSaveDraft) ----------
  res = await call('post', '/import', { body: {} });
  assert.strictEqual(res.statusCode, 400, 'no productId/url: refused before any credit check or AliExpress call');

  creditBalance = 0;
  res = await call('post', '/import', { body: { productId: '1005003784285827' } });
  assert.strictEqual(res.statusCode, 402);
  creditBalance = 5;

  storeOk = false;
  res = await call('post', '/import', { body: { productId: '1005003784285827' } });
  assert.strictEqual(res.statusCode, 409);
  storeOk = true;

  adapterCalls.length = 0;
  res = await call('post', '/import', { body: { productId: '1005003784285827', skuId: 'S1', markupPercent: 25 } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.draft.sku, 'AE-S1');
  const importCall = adapterCalls.find((c) => c[0] === 'import');
  assert.deepStrictEqual(importCall, ['import', 'u1', { productId: '1005003784285827', skuId: 'S1' }, 25]);

  console.log('aliexpress import route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
