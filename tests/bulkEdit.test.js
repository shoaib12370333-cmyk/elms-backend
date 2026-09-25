// Drafts -> Bulk edit: one set of changes for every selected draft. Every field is a real ELMS field; a request is checked before anything
// is saved; a draft that cannot take a change is skipped with the reason (never half-edited); dryRun saves nothing; running the same edit
// twice changes nothing the second time. The real service and route run here; the database and the exchange rates are stand-ins.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let fxDown = false;
stub('services/currencyService', { convertAmount: async (a, from, to) => { if (fxDown) throw new Error('Exchange rates are unavailable right now.'); if (from === to) return { amount: a, rate: 1 }; if (from === 'USD' && to === 'GBP') return { amount: a * 0.8, rate: 0.8 }; throw new Error('No exchange rate for ' + from + ' to ' + to + '.'); } });
stub('models/usersModel', { getPricingRule: async () => saved, hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {} });

const S = require('../services/bulkEditService');
const P = require('../services/pricingService');

// ---- an in-memory set of drafts that saves the way the real model does (serialized names) ----
const COLUMN = { title: 'title', sellPrice: 'sell_price', markupPercent: 'markup_percent', marginAmount: 'margin_amount', pricingRule: 'pricing_rule', amazonPrice: 'amazon_price', quantity: 'quantity', ebayAspects: 'ebay_aspects', tags: 'tags',
  stockMonitoring: 'stock_monitoring', priceMonitoring: 'price_monitoring', countryLocation: 'country_location', locationCity: 'location_city', postalCode: 'postal_code', useDynamicPolicies: 'use_dynamic_policies',
  paymentPolicyId: 'payment_policy_id', fulfillmentPolicyId: 'shipping_policy_id', returnPolicyId: 'return_policy_id' };
let rows = {};
let imports = {};
let saved = null; // the seller's saved pricing rule
const writes = [];
const deps = {
  getListingById: async (u, id) => (rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null),
  updateListing: async (u, id, fields) => { writes.push({ id, fields }); for (const [k, v] of Object.entries(fields)) { assert.ok(COLUMN[k], 'a field the model knows: ' + k); rows[id][COLUMN[k]] = v; } },
  getImportById: async (u, id) => imports[id] || null,
};
const draft = (id, over = {}) => ({ id, title: 'Blue Kettle 1.7L', sku: 'B0' + id, status: 'draft', ebay_account_id: 'A1', currency: 'GBP', amazon_price: 10, sell_price: 10, quantity: 1, tags: [], ebay_aspects: { Brand: ['Acme'], Colour: ['Blue'] },
  stock_monitoring: true, price_monitoring: true, use_dynamic_policies: false, payment_policy_id: null, shipping_policy_id: null, return_policy_id: null, country_location: null, location_city: null, postal_code: null, pricing_rule: null, import_id: null, ...over });
const reset = () => { rows = { D1: draft('D1'), D2: draft('D2', { title: 'Red Toaster 2 slice' }), D3: draft('D3', { title: 'Green Blender' }) }; imports = {}; saved = null; writes.length = 0; fxDown = false; };
const valid = (raw) => S.validateChanges(raw, { userId: 'u1', getSavedRule: async () => saved });
const run = async (raw, ids = ['D1', 'D2', 'D3'], dryRun = false) => S.bulkEdit({ userId: 'u1', ids, changes: await valid(raw), dryRun }, deps);
const refuses = async (raw, re) => assert.rejects(() => valid(raw), (e) => e.statusCode === 400 && re.test(e.message), JSON.stringify(raw));
const RULE = { enabled: true, currency: 'GBP', feePercent: 13, feeFixed: 0.3, profitPercent: 30, profitFixed: 0, minProfit: 0, shipping: 0, centsEnding: null, tiers: [] };

(async () => {
  // ---------- the request is checked as a whole ----------
  reset();
  await refuses({}, /at least one thing/); await refuses(undefined, /at least one thing/); await refuses({ nothing: 1 }, /at least one thing/);
  await refuses({ quantity: 0 }, /Quantity/); await refuses({ quantity: 1000 }, /Quantity/); await refuses({ quantity: 2.5 }, /Quantity/); await refuses({ quantity: '' }, /Quantity/); await refuses({ quantity: 'x' }, /Quantity/);
  assert.strictEqual((await valid({ quantity: '5' })).quantity, 5);
  await refuses({ title: {} }, /what to do with the titles/); await refuses({ title: { op: 'replace', find: '  ' } }, /text to find/); await refuses({ title: { op: 'prefix', text: '' } }, /text to add/);
  await refuses({ title: { op: 'case', case: 'shout' } }, /upper case/); await refuses({ title: { op: 'suffix', text: 'x'.repeat(81) } }, /at most 80/);
  await refuses({ brand: ' ' }, /Type the brand/); await refuses({ brand: 'x'.repeat(66) }, /at most 65/);
  await refuses({ tags: { mode: 'shuffle', tags: ['a'] } }, /add, remove, replace or clear/); await refuses({ tags: { mode: 'add', tags: [] } }, /at least one tag/); await refuses({ tags: { mode: 'add', tags: ' , ' } }, /at least one tag/);
  assert.deepStrictEqual((await valid({ tags: { mode: 'clear' } })).tags, { mode: 'clear', tags: [] });
  assert.deepStrictEqual((await valid({ tags: { mode: 'add', tags: 'a, B ,a' } })).tags.tags, ['a', 'B'], 'a text list, cleaned, no repeats');
  await refuses({ stockMonitoring: 'yes' }, /on or off/); await refuses({ priceMonitoring: 1 }, /on or off/);
  await refuses({ location: {} }, /country, city or postcode/); await refuses({ location: { countryLocation: 'GBR' } }, /2-letter/); await refuses({ location: { postalCode: '!!' } }, /postcode/);
  assert.deepStrictEqual((await valid({ location: { countryLocation: 'uk', postalCode: 'sw1a 1aa', locationCity: ' London ' } })).location, { countryLocation: 'GB', postalCode: 'SW1A 1AA', locationCity: 'London' });
  await refuses({ policies: {} }, /account default policies/); await refuses({ policies: { mode: 'choose' } }, /at least one policy/); await refuses({ policies: { mode: 'choose', paymentPolicyId: 'bad id!' } }, /payment policy is not valid/);
  assert.deepStrictEqual((await valid({ policies: { mode: 'default' } })).policies, { useDynamicPolicies: true });
  assert.deepStrictEqual((await valid({ policies: { mode: 'choose', returnPolicyId: 'R1', paymentPolicyId: '' } })).policies, { useDynamicPolicies: false, returnPolicyId: 'R1' });
  await refuses({ price: {} }, /how the price is set/); await refuses({ price: { mode: 'saved' } }, /no saved pricing rule/);
  await refuses({ price: { mode: 'custom', rule: { feePercent: 90 } } }, /Fees %/);
  saved = { ...RULE, feePercent: 999 };
  await refuses({ price: { mode: 'saved' } }, /not valid/);
  saved = null;

  // ---------- title ----------
  reset();
  let out = await run({ title: { op: 'replace', find: 'blue', with: 'Navy' } });
  assert.deepStrictEqual(out.summary, { changed: 1, unchanged: 2, skipped: 0 });
  assert.strictEqual(rows.D1.title, 'Navy Kettle 1.7L', 'case-insensitive by default');
  assert.deepStrictEqual(out.results[0].diff, [{ field: 'Title', from: 'Blue Kettle 1.7L', to: 'Navy Kettle 1.7L' }]);
  assert.strictEqual(rows.D2.title, 'Red Toaster 2 slice', 'the others are untouched');
  reset();
  await run({ title: { op: 'replace', find: 'blue', with: 'Navy', caseSensitive: true } });
  assert.strictEqual(rows.D1.title, 'Blue Kettle 1.7L', 'case-sensitive: "blue" is not "Blue"');
  reset();
  await run({ title: { op: 'replace', find: ' 1.7L', with: '' } });
  assert.strictEqual(rows.D1.title, 'Blue Kettle', 'removing text (an empty replacement) leaves no double space');
  await run({ title: { op: 'replace', find: 'a.c', with: 'X' } });
  assert.strictEqual(rows.D2.title, 'Red Toaster 2 slice', 'the text is searched as typed, not as a pattern');
  reset();
  await run({ title: { op: 'prefix', text: 'New' } }); assert.strictEqual(rows.D3.title, 'New Green Blender');
  await run({ title: { op: 'suffix', text: 'UK Seller' } }); assert.strictEqual(rows.D3.title, 'New Green Blender UK Seller');
  await run({ title: { op: 'case', case: 'upper' } }); assert.strictEqual(rows.D1.title, 'NEW BLUE KETTLE 1.7L UK SELLER');
  await run({ title: { op: 'case', case: 'lower' } }); assert.strictEqual(rows.D1.title, 'new blue kettle 1.7l uk seller');
  await run({ title: { op: 'case', case: 'title' } }); assert.strictEqual(rows.D1.title, 'New Blue Kettle 1.7l Uk Seller');
  assert.strictEqual(S.titleCase("nike AIR max o'neil t-shirt"), "Nike Air Max O'neil T-Shirt");
  // eBay's 80 characters: a draft that would go over is skipped whole, not cut short
  reset(); rows.D2.title = 'R'.repeat(75);
  out = await run({ title: { op: 'suffix', text: 'Free Postage' }, quantity: 3 });
  assert.strictEqual(out.results[1].status, 'skipped'); assert.match(out.results[1].reason, /would be 88 characters; eBay allows 80/);
  assert.strictEqual(rows.D2.quantity, 1, 'never half-edited: the quantity was not changed either');
  assert.strictEqual(rows.D1.title, 'Blue Kettle 1.7L Free Postage'); assert.strictEqual(rows.D1.quantity, 3);
  reset(); rows.D1.title = '';
  out = await run({ title: { op: 'prefix', text: 'X' } });
  assert.match(out.results[0].reason, /no title/);
  reset(); rows.D1.title = 'Cheap';
  out = await run({ title: { op: 'replace', find: 'Cheap', with: '' } });
  assert.match(out.results[0].reason, /empty/); assert.strictEqual(rows.D1.title, 'Cheap');

  // ---------- quantity, monitoring, tags, brand ----------
  reset();
  out = await run({ quantity: 5, stockMonitoring: false, priceMonitoring: false });
  assert.deepStrictEqual(rows.D1.quantity, 5); assert.strictEqual(rows.D1.stock_monitoring, false); assert.strictEqual(rows.D1.price_monitoring, false);
  assert.deepStrictEqual(out.results[0].diff.map((d) => d.field), ['Quantity', 'Stock monitoring', 'Price monitoring']);
  out = await run({ quantity: 5, stockMonitoring: false });
  assert.deepStrictEqual(out.summary, { changed: 0, unchanged: 3, skipped: 0 }, 'the same edit again changes nothing');
  reset(); rows.D1.tags = ['gift', 'kitchen']; rows.D2.tags = ['gift'];
  await run({ tags: { mode: 'add', tags: ['sale', 'Gift'] } });
  assert.deepStrictEqual([rows.D1.tags, rows.D2.tags, rows.D3.tags], [['gift', 'kitchen', 'sale', 'Gift'], ['gift', 'sale', 'Gift'], ['sale', 'Gift']], 'added, no repeats of the same spelling');
  await run({ tags: { mode: 'remove', tags: ['GIFT'] } });
  assert.deepStrictEqual([rows.D1.tags, rows.D3.tags], [['kitchen', 'sale'], ['sale']], 'removed whatever the capitals');
  await run({ tags: { mode: 'replace', tags: ['new'] } }); assert.deepStrictEqual(rows.D1.tags, ['new']);
  await run({ tags: { mode: 'clear' } }); assert.deepStrictEqual([rows.D1.tags, rows.D2.tags], [[], []]);
  reset();
  out = await run({ brand: 'Tefal' });
  assert.deepStrictEqual(rows.D1.ebay_aspects, { Brand: ['Tefal'], Colour: ['Blue'] }, 'the other item specifics stay');
  assert.deepStrictEqual(out.results[0].diff, [{ field: 'Brand', from: 'Acme', to: 'Tefal' }]);
  out = await run({ brand: 'Tefal' }); assert.strictEqual(out.summary.changed, 0);
  // a draft whose specifics still live on its import keeps them
  reset(); rows.D1.ebay_aspects = {}; rows.D1.import_id = 'I1'; imports.I1 = { product: { ebayAspects: { Brand: ['Old'], Material: ['Steel'] } } };
  await run({ brand: 'Tefal' }, ['D1']);
  assert.deepStrictEqual(rows.D1.ebay_aspects, { Brand: ['Tefal'], Material: ['Steel'] });
  reset(); rows.D1.ebay_aspects = {};
  await run({ brand: 'Tefal' }, ['D1']);
  assert.deepStrictEqual(rows.D1.ebay_aspects, { Brand: ['Tefal'] });

  // ---------- location and policies ----------
  reset();
  await run({ location: { countryLocation: 'gb', postalCode: 'sw1a 1aa' } });
  assert.deepStrictEqual([rows.D1.country_location, rows.D1.postal_code, rows.D1.location_city], ['GB', 'SW1A 1AA', null], 'only what was typed changes');
  reset();
  await run({ policies: { mode: 'default' } });
  assert.strictEqual(rows.D1.use_dynamic_policies, true);
  await run({ policies: { mode: 'choose', paymentPolicyId: 'P1', returnPolicyId: 'R1' } });
  assert.deepStrictEqual([rows.D1.use_dynamic_policies, rows.D1.payment_policy_id, rows.D1.return_policy_id, rows.D1.shipping_policy_id], [false, 'P1', 'R1', null], 'a policy left out stays as it is');
  reset(); rows.D3.ebay_account_id = 'A2';
  await assert.rejects(() => run({ policies: { mode: 'choose', paymentPolicyId: 'P1' } }), (e) => e.statusCode === 400 && /different stores/.test(e.message));
  assert.strictEqual(writes.length, 0, 'nothing saved when the policies cannot apply');
  rows.D3.ebay_account_id = null;
  await assert.rejects(() => run({ policies: { mode: 'choose', paymentPolicyId: 'P1' } }), (e) => /different stores/.test(e.message));
  out = await run({ policies: { mode: 'default' } });
  assert.strictEqual(out.summary.changed, 3, 'the account default policies work across stores');

  // ---------- price ----------
  reset(); saved = { ...RULE, enabled: false }; // a saved rule can be applied even while it is switched off for new imports
  out = await run({ price: { mode: 'saved' } }, ['D1']);
  const expected = P.computePrice(10, RULE);
  assert.strictEqual(rows.D1.sell_price, expected.price);
  assert.strictEqual(rows.D1.sell_price, 15.29);
  assert.deepStrictEqual([rows.D1.markup_percent, rows.D1.margin_amount], [expected.markupPercent, Number((expected.price - 10).toFixed(2))]);
  assert.strictEqual(rows.D1.pricing_rule.feePercent, 13); assert.strictEqual(rows.D1.pricing_rule.currency, 'GBP'); assert.strictEqual(rows.D1.pricing_rule.enabled, true, 'the copy on the draft is the working rule');
  assert.deepStrictEqual(out.results[0].diff, [{ field: 'Price', from: 10, to: 15.29 }]);
  out = await run({ price: { mode: 'saved' } }, ['D1']);
  assert.strictEqual(out.summary.unchanged, 1, 'the same rule again changes nothing');
  // typed numbers: the seller's own example
  reset();
  rows.D1.amazon_price = 142.19; rows.D1.sell_price = 142.19;
  await run({ price: { mode: 'custom', rule: { currency: 'GBP', feePercent: 13, feeFixed: 0.3, profitPercent: 10, profitFixed: 0.3 } } }, ['D1']);
  assert.strictEqual(rows.D1.sell_price, 180.47);
  // no fees and no fixed amounts is a plain markup, as the old "% profit" box was
  reset();
  await run({ price: { mode: 'custom', rule: { currency: 'GBP', feePercent: 0, feeFixed: 0, profitPercent: 20, profitFixed: 0 } } }, ['D1']);
  assert.strictEqual(rows.D1.sell_price, 12);
  // price cents
  reset();
  await run({ price: { mode: 'custom', rule: { feePercent: 0, feeFixed: 0, profitPercent: 20, profitFixed: 0, centsEnding: 99 } } }, ['D1']);
  assert.strictEqual(rows.D1.sell_price, 12.99);
  // the cost comes from the import when the draft has none, and the draft then keeps it
  reset(); rows.D1.amazon_price = null; rows.D1.import_id = 'I1'; imports.I1 = { amazon_price: 8, product: { price: 8 } };
  await run({ price: { mode: 'custom', rule: { feePercent: 0, feeFixed: 0, profitPercent: 50, profitFixed: 0 } } }, ['D1']);
  assert.deepStrictEqual([rows.D1.sell_price, rows.D1.amazon_price], [12, 8]);
  reset(); rows.D1.amazon_price = null;
  out = await run({ price: { mode: 'custom', rule: { profitPercent: 20 } } }, ['D1']);
  assert.match(out.results[0].reason, /No Amazon price/);
  // a rule in another currency is converted for the draft's currency; no exchange rate = the draft is skipped, nothing saved
  reset(); rows.D1.currency = 'GBP';
  await run({ price: { mode: 'custom', rule: { currency: 'USD', feePercent: 0, feeFixed: 1, profitPercent: 0, profitFixed: 0 } } }, ['D1']);
  assert.strictEqual(rows.D1.pricing_rule.feeFixed, 0.8, '1 dollar is 0.80 pounds');
  assert.strictEqual(rows.D1.sell_price, 10.8);
  reset(); fxDown = true;
  out = await run({ price: { mode: 'custom', rule: { currency: 'USD', feeFixed: 1 } } }, ['D1']);
  assert.strictEqual(out.results[0].status, 'skipped'); assert.match(out.results[0].reason, /exchange rate/); assert.strictEqual(writes.length, 0);
  // after a bulk price a stock check re-prices by the rule (the draft keeps it)
  const { repriceFor } = require('../services/repricingService');
  reset(); saved = RULE;
  await run({ price: { mode: 'saved' } }, ['D1']);
  assert.strictEqual(repriceFor(rows.D1, 20, 5.29).sellPrice, P.computePrice(20, RULE).price);

  // ---------- which drafts are edited ----------
  reset(); rows.D2.status = 'published'; rows.D3.status = 'error';
  out = await run({ quantity: 4 }, ['D1', 'D2', 'D3', 'NOPE']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'skipped', 'changed', 'skipped']);
  assert.match(out.results[1].reason, /Only drafts/); assert.match(out.results[3].reason, /Not found/);
  assert.strictEqual(rows.D2.quantity, 1, 'a live listing is never touched');
  assert.strictEqual(rows.D3.quantity, 4, 'a draft that failed to publish is still a draft to edit');

  // ---------- dry run: what would happen, nothing saved, and the same answer as the real run ----------
  reset(); saved = RULE;
  const changes = { title: { op: 'prefix', text: 'New' }, price: { mode: 'saved' }, quantity: 2, tags: { mode: 'add', tags: ['x'] }, brand: 'Tefal', stockMonitoring: false };
  const dry = await run(changes, ['D1', 'D2', 'D3'], true);
  assert.strictEqual(writes.length, 0, 'a dry run saves nothing');
  assert.deepStrictEqual(rows.D1, draft('D1'));
  const real = await run(changes, ['D1', 'D2', 'D3'], false);
  assert.deepStrictEqual(real.results, dry.results, 'the preview is exactly what the edit does');
  assert.deepStrictEqual(real.summary, { changed: 3, unchanged: 0, skipped: 0 });
  assert.strictEqual(rows.D2.title, 'New Red Toaster 2 slice');
  const again = await run(changes, ['D1', 'D2', 'D3']);
  assert.strictEqual(again.summary.changed, 3, 'a prefix added again is a change again (the title changes)');
  // one broken draft does not stop the rest
  reset();
  const boom = { ...deps, getListingById: async (u, id) => { if (id === 'D2') throw new Error('database hiccup'); return deps.getListingById(u, id); } };
  out = await S.bulkEdit({ userId: 'u1', ids: ['D1', 'D2', 'D3'], changes: await valid({ quantity: 9 }), dryRun: false }, boom);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'skipped', 'changed']);
  assert.match(out.results[1].reason, /database hiccup/);

  // ---------- the route ----------
  reset();
  const noop = async () => null;
  const fakes = {
    '../models/listingsModel': { listListings: noop, getListingById: deps.getListingById, updateListing: deps.updateListing, updateListingStats: noop, updateListingSettings: noop },
    '../services/ebayStatsService': { fetchItemTraffic: noop },
    '../services/listingStatsService': { syncStatsForAccount: noop },
    '../services/ebayListingService': { reviseActiveListing: noop, fetchLiveListing: noop, createOrGetCustomLocation: noop, publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop },
    '../services/publishQueueService': { processOneQueuedListing: noop },
    '../models/ebayAccountsModel': { listEbayAccounts: noop, getEbayAccountById: noop, getEbayAccountRefreshToken: async () => 'rt' },
    '../models/importsModel': { getImportById: deps.getImportById },
    '../services/publishPreflightService': { checkAspects: noop },
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../services/publishRunner': { enqueuePublish: noop },
    '../models/usersModel': { hasCredits: noop, spendCredit: noop, refundCredit: noop, getPricingRule: async () => saved },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]listings\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/listings');
  Module._load = orig;
  const h = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/bulk-edit' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await h({ userId: 'u1', body }, res); return res; };
  let res = await call({ ids: [], changes: { quantity: 2 } });
  assert.strictEqual(res.statusCode, 400);
  res = await call({ ids: Array.from({ length: 501 }, (_, i) => 'X' + i), changes: { quantity: 2 } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 500/);
  res = await call({ ids: ['D1'], changes: { quantity: 0 } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /Quantity/); assert.strictEqual(writes.length, 0);
  res = await call({ ids: ['D1', 'D1', 'D2'], changes: { quantity: 6 }, dryRun: true });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.dryRun, res.body.results.length, res.body.summary.changed], [200, true, true, 2, 2], 'the same id twice is one draft');
  assert.strictEqual(writes.length, 0);
  res = await call({ ids: ['D1'], changes: { quantity: 6 } });
  assert.strictEqual(res.body.dryRun, false); assert.strictEqual(rows.D1.quantity, 6);
  saved = null;
  res = await call({ ids: ['D1'], changes: { price: { mode: 'saved' } } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /no saved pricing rule/);

  console.log('bulk edit: all good');
})().catch((err) => { console.error(err); process.exit(1); });
