// What a product sells for on eBay (services/ebayMarketService.js): the search asked (barcode first, then title words), the numbers made
// from the answer, and everything that can go wrong (eBay says no, busy, no token) turned into a plain "not available".
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const U1 = '1'.repeat(24);
const UK = 'a'.repeat(24);
stub('models/ebayAccountsModel', {
  getActiveEbayAccount: async () => ({ id: UK, label: 'Trendy UK', marketplaceId: 'EBAY_GB' }),
  getEbayAccountById: async (u, id) => (id === UK ? { id: UK, label: 'Trendy UK', marketplaceId: 'EBAY_GB' } : null),
  listEbayAccounts: async () => [],
});
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const market = require('../services/ebayMarketService');

const item = (price, over = {}) => ({ itemId: 'v1|' + Math.random(), title: 'Acme Widget 3-pack', price: { value: String(price), currency: 'GBP' }, seller: { username: 'seller' + Math.floor(price * 10) }, itemWebUrl: 'https://www.ebay.co.uk/itm/123', shippingOptions: [{ shippingCost: { value: '0.00', currency: 'GBP' } }], ...over });

(async () => {
  // ---------- small pieces ----------
  assert.strictEqual(market.keywordsOf('Acme Widget 3-Pack [Black] (for iPhone), Strong | Light: new!'), 'Acme Widget 3-Pack Strong Light new', 'brackets and separators are gone');
  assert.strictEqual(market.keywordsOf('one two three four five six seven eight'), 'one two three four five six', 'the first six words');
  assert.strictEqual(market.keywordsOf(null), '');
  assert.strictEqual(market.gtinOf('EAN: 5012345678900, 5012345678917'), '5012345678900');
  assert.strictEqual(market.gtinOf('1234'), null, 'too short to be a barcode');
  assert.strictEqual(market.gtinOf(undefined), null);

  // ---------- the numbers ----------
  const items = [item(9.99), item(12), item(13.49), item(14), item(15.5)];
  let s = market.summarize({ total: 37, itemSummaries: items }, 'GBP', false);
  assert.deepStrictEqual([s.available, s.total, s.count, s.min, s.median, s.max, s.exact], [true, 37, 5, 9.99, 13.49, 15.5, false]);
  assert.strictEqual(s.currency, 'GBP');
  assert.deepStrictEqual(s.cheapest.map((c) => c.price), [9.99, 12, 13.49], 'the cheapest three, cheapest first');
  assert.strictEqual(s.cheapest[0].url, 'https://www.ebay.co.uk/itm/123');

  // delivery is part of what the buyer pays
  s = market.summarize({ total: 2, itemSummaries: [item(10, { shippingOptions: [{ shippingCost: { value: '3.50', currency: 'GBP' } }] }), item(12)] }, 'GBP', true);
  assert.deepStrictEqual([s.min, s.max, s.exact], [12, 13.5, true], '10.00 + 3.50 delivery = 13.50');
  assert.strictEqual(s.cheapest[0].shipping, 0);
  assert.strictEqual(s.cheapest[1].shipping, 3.5);

  // another currency, no price, junk: left out
  s = market.summarize({ total: 4, itemSummaries: [item(10), item(11, { price: { value: '11', currency: 'USD' } }), { title: 'no price' }, null, item(0)] }, 'GBP', false);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.min, 10);

  // accessories and lots are far from the middle: with enough listings they are dropped
  const many = [item(1.2), item(1.5), item(12), item(12.5), item(13), item(13.5), item(14), item(14.5), item(15), item(95)];
  s = market.summarize({ total: 400, itemSummaries: many }, 'GBP', false);
  assert.strictEqual(s.count, 7, 'the 1.20, 1.50 and 95.00 are out');
  assert.strictEqual(s.min, 12);
  assert.strictEqual(s.max, 15);
  assert.strictEqual(s.total, 400, 'the number eBay says match is kept as it is');

  // links only to eBay
  s = market.summarize({ total: 1, itemSummaries: [item(10, { itemWebUrl: 'https://evil.example/itm/1' }), item(11, { itemWebUrl: 'javascript:alert(1)' })] }, 'GBP', false);
  assert.deepStrictEqual(s.cheapest.map((c) => c.url), [null, null]);

  // nothing found
  s = market.summarize({ total: 0 }, 'GBP', false);
  assert.deepStrictEqual([s.available, s.count, s.median], [true, 0, null]);

  // ---------- asking eBay ----------
  const make = (respond, extra = {}) => {
    const calls = [];
    const service = market.createMarketService({
      getToken: async () => 'app-token',
      http: { get: async (url, opts) => { calls.push({ url, params: opts.params, headers: opts.headers }); return respond(opts.params, calls.length); } },
      ...extra,
    });
    return { service, calls };
  };
  const ok = (list, total) => ({ data: { total: total == null ? list.length : total, itemSummaries: list } });
  const status = (code) => Object.assign(new Error('http ' + code), { response: { status: code } });

  // by title words
  let env = make(() => ok(items, 37));
  let r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget 3-pack [Black]' });
  assert.deepStrictEqual([r.available, r.exact, r.count, r.median, r.marketplaceId], [true, false, 5, 13.49, 'EBAY_GB']);
  assert.deepStrictEqual(r.query, { q: 'Acme Widget 3-pack' });
  assert.strictEqual(env.calls.length, 1);
  assert.ok(env.calls[0].url.endsWith('/buy/browse/v1/item_summary/search'));
  assert.deepStrictEqual(env.calls[0].params, { limit: 50, q: 'Acme Widget 3-pack', filter: 'buyingOptions:{FIXED_PRICE},conditions:{NEW}' });
  assert.strictEqual(env.calls[0].headers.Authorization, 'Bearer app-token');
  assert.strictEqual(env.calls[0].headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_GB');

  // by barcode: the same product
  env = make(() => ok(items, 12));
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget', gtin: 'EAN 5012345678900' });
  assert.strictEqual(r.exact, true);
  assert.deepStrictEqual(r.query, { gtin: '5012345678900' });
  assert.strictEqual(env.calls[0].params.gtin, '5012345678900');
  assert.ok(!('q' in env.calls[0].params));

  // a barcode with no match: the title words
  env = make((params) => (params.gtin ? ok([], 0) : ok(items, 20)));
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget', gtin: '5012345678900' });
  assert.strictEqual(r.exact, false);
  assert.strictEqual(r.count, 5);
  assert.deepStrictEqual(env.calls.map((c) => Boolean(c.params.gtin)), [true, false]);

  // a barcode eBay rejects: the title words too
  env = make((params) => { if (params.gtin) throw status(400); return ok(items); });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget', gtin: '5012345678900' });
  assert.strictEqual(r.count, 5);

  // a filter eBay does not take: asked again with less
  env = make((params) => { if (params.filter && params.filter.includes('conditions')) throw status(400); return ok(items); });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.strictEqual(r.count, 5);
  assert.deepStrictEqual(env.calls.map((c) => c.params.filter), ['buyingOptions:{FIXED_PRICE},conditions:{NEW}', 'buyingOptions:{FIXED_PRICE}']);
  // ... and with none at all
  env = make((params) => { if (params.filter) throw status(400); return ok(items); });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_DE', title: 'Acme Widget' });
  assert.strictEqual(r.count, 0, 'EUR marketplace: GBP items are not comparable');
  assert.strictEqual(env.calls.length, 3);

  // nothing at all found
  env = make(() => ok([], 0));
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Zzz Qqq' });
  assert.deepStrictEqual([r.available, r.total, r.count], [true, 0, 0]);

  // eBay says no / busy / is down; no token; not a marketplace; no title
  env = make(() => { throw status(500); });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.deepStrictEqual([r.available, r.reason], [false, 'unavailable']);
  env = make(() => { throw status(429); });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.deepStrictEqual([r.available, r.reason], [false, 'busy']);
  env = make(() => ok(items), { getToken: async () => { throw new Error('EBAY_CLIENT_ID is not set'); } });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.deepStrictEqual([r.available, r.reason], [false, 'not_configured']);
  assert.ok(!/EBAY_CLIENT_ID/.test(r.message), 'the reason for the person never names a secret');
  env = make(() => ok(items));
  r = await env.service.marketFor({ marketplaceId: 'EBAY_MARS', title: 'Acme Widget' });
  assert.strictEqual(r.reason, 'unsupported');
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: '   ' });
  assert.strictEqual(r.reason, 'no_query');
  assert.strictEqual(env.calls.length, 0, 'nothing was asked');

  // ---------- kept, shared, limited ----------
  let clock = 1000;
  env = make(() => ok(items), { now: () => clock });
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'ACME widget' });
  assert.strictEqual(env.calls.length, 1, 'the same product again: kept');
  await env.service.marketFor({ marketplaceId: 'EBAY_US', title: 'Acme Widget' });
  assert.strictEqual(env.calls.length, 2, 'another marketplace is another question');
  clock += 21 * 60 * 1000;
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.strictEqual(env.calls.length, 3, 'after twenty minutes it is asked again');

  // an answer that failed is not kept
  let fails = true;
  env = make(() => { if (fails) throw status(500); return ok(items); });
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  fails = false;
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' });
  assert.strictEqual(r.available, true);

  // two people at once: one search
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  env = make(async () => { await gate; return ok(items); });
  const both = Promise.all([env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' }), env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Acme Widget' })]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const [a, b] = await both;
  assert.strictEqual(env.calls.length, 1);
  assert.strictEqual(a.median, b.median);

  // the day's budget
  env = make(() => ok(items), { dailyBudget: 2 });
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'One' });
  await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Two' });
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'Three' });
  assert.deepStrictEqual([r.available, r.reason], [false, 'busy']);
  assert.strictEqual(env.calls.length, 2);
  r = await env.service.marketFor({ marketplaceId: 'EBAY_GB', title: 'One' });
  assert.strictEqual(r.available, true, 'what is already known is still answered');

  // ---------- the route ----------
  const extensionRoutes = require('../routes/extension');
  const layer = extensionRoutes.stack.find((l) => l.route && l.route.path === '/market' && l.route.methods.post);
  assert.ok(layer, 'POST /market');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (req) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await handle({ userId: U1, body: {}, ...req }, res); return res; };
  // no eBay keys in the test: the answer is "not available", never an error
  let res = await call({ body: { title: 'Acme Widget', storeId: UK } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.market.available, false);
  res = await call({ body: { title: 'Acme Widget', storeId: 'c'.repeat(24) } });
  assert.strictEqual(res.statusCode, 404, 'a store that is not the user\'s');
  res = await call({ body: { title: 'Acme Widget', storeId: 'not-an-id' } });
  assert.strictEqual(res.statusCode, 404);

  console.log('extension market tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
