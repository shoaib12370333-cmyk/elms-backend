// Two endpoints asked the paid Amazon API for anybody who was signed in, for nothing: /api/fetch-variant (charged no credit whatever the
// admin set, no limit, no cache) and /api/tools/image-extractor (free by default, no cache). Now: only a product the person imported
// (or one of its variants), the admin's cost is charged, a pace per person, and a product asked again lately is not looked up again.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const balance = { u1: 5 };
const log = { spent: 0, refunded: 0 };
stub('models/usersModel', {
  hasCredits: async (id, n = 1) => n <= 0 || (balance[id] || 0) >= n,
  spendCredit: async (id, n = 1) => { if (n <= 0) return true; if ((balance[id] || 0) < n) return false; balance[id] -= n; log.spent += 1; return true; },
  refundCredit: async (id, n = 1) => { if (n > 0) { balance[id] += n; log.refunded += 1; } return true; },
});
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
// the person's imports: the product itself and its variants
const imports = [{ userId: 'u1', asin: 'B0PARENT01', product: { asin: 'B0PARENT01', variants: [{ asin: 'B0VARIANT1' }, { asin: 'B0VARIANT2' }, { asin: 'B0VARIANT3' }] } }];
stub('models/schemas/Import', {
  exists: async ({ userId, $or }) => (imports.some((row) => row.userId === userId && $or.some((c) => (c.asin && row.asin === c.asin) || (c['product.asin'] && row.product.asin === c['product.asin']) || (c['product.variants.asin'] && row.product.variants.some((v) => v.asin === c['product.variants.asin'])))) ? { _id: 1 } : null),
});
const canopy = require('../services/canopyAmazonService');
const lookups = [];
let lookupFails = false;
canopy.fetchProductByAsin = async (asin, country) => { lookups.push([asin, country]); if (lookupFails) throw Object.assign(new Error('Amazon down'), { statusCode: 502 }); return { asin, title: 'Item ' + asin, price: 20, images: ['https://m.media-amazon.com/images/I/' + asin + '.jpg'] }; };
const productCache = new Map();
stub('services/productCacheService', { getCachedProduct: async (asin) => productCache.get(asin) || null, setCachedProduct: async (asin, country, product) => { productCache.set(asin, product); } });
stub('models/ebayAccountsModel', { getActiveEbayAccount: async () => null });
const { ACTION_COSTS } = require('../config/actionCosts');

const variantRoute = require('../routes/fetchVariant');
const toolsRoute = require('../routes/researchTools');
const layer = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l; };
const last = (l) => l.route.stack[l.route.stack.length - 1].handle;
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const variant = async (body, userId = 'u1') => { const res = fakeRes(); await last(layer(variantRoute, 'post', '/'))({ userId, body }, res); return res; };
const extract = async (query, userId = 'u1') => { const res = fakeRes(); await last(layer(toolsRoute, 'get', '/image-extractor'))({ userId, query }, res); return res; };
const reset = () => { balance.u1 = 5; log.spent = 0; log.refunded = 0; lookups.length = 0; lookupFails = false; productCache.clear(); };

(async () => {
  // both routes have a pace per person (requireAuth, limiter, handler)
  assert.strictEqual(layer(variantRoute, 'post', '/').route.stack.length, 3, 'fetch-variant: sign-in, pace, handler');
  assert.strictEqual(layer(toolsRoute, 'get', '/image-extractor').route.stack.length, 3, 'image-extractor: sign-in, pace, handler');

  // ---------- /api/fetch-variant ----------
  reset();
  let res = await variant({});
  assert.strictEqual(res.statusCode, 400);
  res = await variant({ asin: 'not an asin!' });
  assert.strictEqual(res.statusCode, 400);
  res = await variant({ asin: 'B0STRANGER' });
  assert.strictEqual(res.statusCode, 404, 'a product that is not one of the person\'s imports is not looked up');
  assert.match(res.body.error, /not one of your imports/);
  res = await variant({ asin: 'B0VARIANT1' }, 'u2');
  assert.strictEqual(res.statusCode, 404, 'and never for somebody else');
  assert.strictEqual(lookups.length, 0, 'no Amazon call for any of these');

  res = await variant({ asin: 'b0variant1', markupPercent: 10 });
  assert.strictEqual(res.body.success, true, 'a variant of an imported product');
  assert.strictEqual(res.body.product.asin, 'B0VARIANT1');
  assert.strictEqual(res.body.suggestedPrice, 22);
  assert.strictEqual(lookups.length, 1);
  res = await variant({ asin: 'B0PARENT01' });
  assert.strictEqual(res.body.success, true, 'the imported product itself');
  assert.strictEqual(lookups.length, 2);
  res = await variant({ asin: 'B0VARIANT1' });
  assert.strictEqual(lookups.length, 2, 'the same product asked again within minutes is not looked up again');

  // the admin's cost is charged (it was ignored before), given back when the lookup fails, and refused without credit
  reset();
  const oldCost = ACTION_COSTS.VARIANT_REFRESH;
  ACTION_COSTS.VARIANT_REFRESH = 2;
  res = await variant({ asin: 'B0VARIANT2' });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(balance.u1, 3, 'charged what the admin set');
  balance.u1 = 5; lookupFails = true;
  res = await variant({ asin: 'B0VARIANT3' }); // not looked up yet, so it is not in the short cache
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(balance.u1, 5, 'a failed lookup costs nothing');
  balance.u1 = 1; lookupFails = false; lookups.length = 0;
  res = await variant({ asin: 'B0VARIANT2' });
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(lookups.length, 0, 'no credit, no Amazon call');
  ACTION_COSTS.VARIANT_REFRESH = oldCost;

  // ---------- /api/tools/image-extractor ----------
  reset();
  assert.strictEqual(ACTION_COSTS.IMAGE_EXTRACTOR, 0, 'still free by default');
  res = await extract({ asin: 'B0AAAAAAAA' });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.images, ['https://m.media-amazon.com/images/I/B0AAAAAAAA.jpg']);
  assert.strictEqual(lookups.length, 1);
  res = await extract({ asin: 'B0AAAAAAAA' });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(lookups.length, 1, 'a product looked up lately comes from the cache: no second Amazon call');
  productCache.set('B0IMPORTED1', { asin: 'B0IMPORTED1', title: 'Imported', images: ['https://m.media-amazon.com/images/I/imported.jpg'] });
  res = await extract({ asin: 'B0IMPORTED1' });
  assert.strictEqual(res.body.title, 'Imported', 'a product that was imported is served from the cache');
  assert.strictEqual(lookups.length, 1);
  lookupFails = true;
  res = await extract({ asin: 'B0FAILING01' });
  assert.strictEqual(res.statusCode, 502, 'a failing Amazon call is reported');
  assert.strictEqual(log.spent, 0, 'free stays free');

  console.log('free Amazon lookups tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
