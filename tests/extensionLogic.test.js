// The extension's maths and checks (extension/logic.js): what a sale leaves after eBay's fees, the price for a wanted profit,
// delivery days, and the list of things the panel warns about.
const assert = require('assert');
const L = require('../extension/logic');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, (msg || '') + ' expected ' + b + ', got ' + a);
const S = L.normalizeSettings({});

// ---- settings ----
assert.deepStrictEqual(S, { feePct: 13, fixed: 0.3, adPct: 0, targetPct: 30 }, 'nothing saved: the defaults');
assert.deepStrictEqual(L.normalizeSettings({ feePct: '99', fixed: '-4', adPct: 'abc', targetPct: '12,5' }), { feePct: 60, fixed: 0, adPct: 0, targetPct: 12.5 }, 'clamped, or the default when it is not a number; a comma is a decimal point');

// ---- what a sale leaves ----
const r = L.evaluate(8, 13.05, S);
near(r.fees, 13.05 * 0.13 + 0.3, 'fees');
near(r.profit, 13.05 - 8 - (13.05 * 0.13 + 0.3), 'profit');
near(r.margin, (r.profit / 13.05) * 100, 'margin is a share of the price');
near(r.roi, (r.profit / 8) * 100, 'roi is a share of the cost');

// the note in memory: a 10% markup on an 8.00 cost is a LOSS after fees
const tenPercent = L.evaluate(8, L.priceAtMarkup(8, 10), S);
assert.strictEqual(L.priceAtMarkup(8, 10), 8.8);
assert.ok(tenPercent.profit < 0, 'a 10% markup loses money');
assert.strictEqual(L.priceAtMarkup(8, ''), 8, 'no markup: the cost');
assert.strictEqual(L.priceAtMarkup(8, '25.5'), 10.04);

// ---- the price that leaves a wanted profit ----
const rec = L.recommendedPrice(8, S, 30);
near(L.evaluate(8, rec, S).profit, 8 * 0.3, 'the recommended price leaves exactly 30% of the cost');
const even = L.breakEvenPrice(8, S);
near(L.evaluate(8, even, S).profit, 0, 'break-even loses nothing');
assert.ok(even < rec && even > 8);
assert.strictEqual(L.recommendedPrice(8, { feePct: 60, fixed: 0, adPct: 40, targetPct: 0 }, 30), null, 'fees that take everything: no price');
assert.strictEqual(L.breakEvenPrice(8, { feePct: 60, fixed: 0, adPct: 40, targetPct: 0 }), null);

const wantedMarkup = L.markupToReach(8, rec);
assert.ok(L.evaluate(8, L.priceAtMarkup(8, wantedMarkup), S).profit >= 8 * 0.3 - 0.01, 'the whole-number markup reaches the target');
assert.ok(L.evaluate(8, L.priceAtMarkup(8, wantedMarkup - 1), S).profit < 8 * 0.3, 'and one less does not');
assert.strictEqual(L.markupToReach(0, 5), null);

// ---- money ----
assert.strictEqual(L.formatMoney(13.05, 'GBP'), '£13.05');
assert.strictEqual(L.formatMoney(-1.2, 'USD'), '-$1.20');
assert.strictEqual(L.formatMoney(2, 'XXBADXX'), 'XXBADXX 2.00', 'an unknown currency still shows the amount');

// ---- delivery days ----
const D = (text, now) => L.parseDeliveryDays(text, new Date(now || '2026-03-10T12:00:00'));
assert.strictEqual(D('FREE delivery Thursday, 12 - Monday, 16 March'), 6, 'the LAST date of a range');
assert.strictEqual(D('Arrives March 25'), 15, 'month first');
assert.strictEqual(D('FREE delivery Tomorrow, 11 March'), 1);
assert.strictEqual(D('Get it tomorrow'), 1);
assert.strictEqual(D('Delivery today'), 0);
assert.strictEqual(D('Delivery Tuesday, 3 January', '2026-12-28T09:00:00'), 6, 'a date that already passed is next year');
assert.strictEqual(D('Lieferung Dienstag, 8. April'), null, 'other languages: no answer, so no warning');
assert.strictEqual(D(''), null);
assert.strictEqual(D(null), null);

// ---- the checks ----
const ids = (checks) => checks.map((c) => c.id);
const level = (checks, id) => (checks.find((c) => c.id === id) || {}).level;
const STORE_UK = { id: 'S1', label: 'Trendy UK', marketplaceId: 'EBAY_GB', currency: 'GBP', isActive: true, amazonOk: true, amazonMessage: null };
const SERVER = { credits: { balance: 40, unlimited: false, importCost: 1 }, stores: [STORE_UK], existing: [], vero: { enabled: true, terms: [], fields: {} } };
const PAGE = { price: 8, currency: 'GBP', unavailable: false, hasCart: true, soldBy: 'Amazon', amazonSold: true, fulfilledByAmazon: true, deliveryText: 'FREE delivery Thursday, 12 March', rating: 4.5, ratingCount: 300, imageCount: 7, variantCount: 1 };

let checks = L.buildChecks({ page: PAGE, server: SERVER, storeId: 'S1', settings: S, markup: 40, now: new Date('2026-03-10T12:00:00') });
assert.strictEqual(L.worstLevel(checks), 'ok', 'a good product at a good markup: nothing to warn about');
assert.ok(ids(checks).includes('seller') && ids(checks).includes('delivery') && ids(checks).includes('rating'), 'the good things are listed too');

// a loss
checks = L.buildChecks({ page: PAGE, server: SERVER, storeId: 'S1', settings: S, markup: 10, now: new Date('2026-03-10T12:00:00') });
assert.strictEqual(level(checks, 'profit'), 'bad');
assert.match(checks.find((c) => c.id === 'profit').text, /lose £0\.64 on every sale/);
assert.strictEqual(checks[0].level, 'bad', 'the worst thing comes first');

// thin margin
checks = L.buildChecks({ page: PAGE, server: SERVER, storeId: 'S1', settings: S, markup: 30, now: new Date('2026-03-10T12:00:00') });
assert.strictEqual(level(checks, 'profit'), 'warn', 'a 30% markup keeps very little');

// no price, unavailable
checks = L.buildChecks({ page: { ...PAGE, price: null, unavailable: true }, server: SERVER, storeId: 'S1', settings: S, markup: 40 });
assert.strictEqual(level(checks, 'price'), 'bad');
assert.strictEqual(level(checks, 'stock'), 'bad');

// third-party seller, slow delivery, a deal, low rating, few pictures, variants
checks = L.buildChecks({
  page: { ...PAGE, soldBy: 'Bob Ltd', amazonSold: false, fulfilledByAmazon: false, deliveryText: 'Delivery 3 - 25 March', listPrice: 12, rating: 3.4, ratingCount: 50, imageCount: 2, variantCount: 4 },
  server: SERVER, storeId: 'S1', settings: S, markup: 60, now: new Date('2026-03-10T12:00:00'),
});
assert.strictEqual(level(checks, 'seller'), 'warn');
assert.match(checks.find((c) => c.id === 'seller').text, /Sold and shipped by Bob Ltd/);
assert.strictEqual(level(checks, 'delivery'), 'warn', '15 days is slow');
assert.match(checks.find((c) => c.id === 'delivery').text, /about 15 days/);
assert.strictEqual(level(checks, 'deal'), 'warn');
assert.strictEqual(level(checks, 'rating'), 'warn');
assert.strictEqual(level(checks, 'images'), 'warn');
assert.strictEqual(level(checks, 'variants'), 'info');
assert.strictEqual(L.worstLevel(checks), 'warn');
checks = L.buildChecks({ page: { ...PAGE, deliveryText: 'Delivery 3 - 5 April' }, server: SERVER, storeId: 'S1', settings: S, markup: 60, now: new Date('2026-03-10T12:00:00') });
assert.strictEqual(level(checks, 'delivery'), 'bad', '26 days is too slow');
checks = L.buildChecks({ page: { ...PAGE, soldBy: 'Bob Ltd', amazonSold: false, fulfilledByAmazon: true }, server: SERVER, storeId: 'S1', settings: S, markup: 60 });
assert.match(checks.find((c) => c.id === 'seller').text, /shipped by Amazon/);

// ---- what ELMS knows ----
const withServer = (patch, page) => L.buildChecks({ page: page || PAGE, server: { ...SERVER, ...patch }, storeId: 'S1', settings: S, markup: 60, now: new Date('2026-03-10T12:00:00') });

// VeRO words
checks = withServer({ vero: { enabled: true, terms: ['nike', 'air max'], fields: { title: ['nike'], bulletPoints: ['air max'] } } });
assert.strictEqual(level(checks, 'vero'), 'bad');
assert.match(checks.find((c) => c.id === 'vero').text, /VeRO words found in the title, bullet points: nike, air max/);
checks = withServer({ vero: { enabled: true, terms: ['nike'], fields: { title: ['nike'] } } });
assert.ok(checks.find((c) => c.id === 'vero').text.includes("VeRO word found in the title: nike."), 'the vero message says: ' + "VeRO word found in the title: nike.");

// credits
checks = withServer({ credits: { balance: 0, unlimited: false, importCost: 1 } });
assert.strictEqual(level(checks, 'credits'), 'bad');
checks = withServer({ credits: { balance: null, unlimited: true, importCost: 1 } });
assert.ok(!ids(checks).includes('credits'), 'an admin has no limit');

// the Amazon site does not fit the store, and no store at all
checks = withServer({ stores: [{ ...STORE_UK, amazonOk: false, amazonMessage: 'This store is set to GB - please paste a link from amazon.co.uk.' }] });
assert.strictEqual(level(checks, 'fit'), 'bad');
assert.ok(checks.find((c) => c.id === 'fit').text.includes("amazon.co.uk"), 'the fit message says: ' + "amazon.co.uk");
checks = withServer({ stores: [] });
assert.strictEqual(level(checks, 'store'), 'bad');

// already imported
const draftRow = { id: 'L1', status: 'draft', storeId: 'S1', storeLabel: 'Trendy UK', sellPrice: 12.99, amazonPrice: 8, currency: 'GBP' };
checks = withServer({ existing: [draftRow] });
assert.strictEqual(level(checks, 'existing'), 'warn');
assert.ok(checks.find((c) => c.id === 'existing').text.includes("Already in your Drafts (Trendy UK). Importing again refreshes it and costs 1 credit."), 'the existing message says: ' + "Already in your Drafts (Trendy UK). Importing again refreshes it and costs 1 credit.");
assert.ok(!ids(checks).includes('livePrice'), 'a draft has no live price to compare');

checks = withServer({ existing: [{ ...draftRow, status: 'published' }] });
assert.strictEqual(level(checks, 'existing'), 'bad');
assert.ok(checks.find((c) => c.id === 'existing').text.includes("Already live on eBay (Trendy UK) at £12.99. It cannot be imported again."), 'the existing message says: ' + "Already live on eBay (Trendy UK) at £12.99. It cannot be imported again.");
assert.strictEqual(level(checks, 'livePrice'), 'ok', 'Amazon still 8.00: unchanged');

checks = withServer({ existing: [{ ...draftRow, status: 'ended' }] });
assert.match(checks.find((c) => c.id === 'existing').text, /Already ended on eBay/);

// a legacy row with no store counts for the chosen store
checks = withServer({ existing: [{ ...draftRow, storeId: null, storeLabel: null }] });
assert.strictEqual(level(checks, 'existing'), 'warn');

// the same product in ANOTHER store only: importing here is fine
const otherStore = { ...STORE_UK, id: 'S2', label: 'US shop', isActive: false };
checks = withServer({ stores: [STORE_UK, otherStore], existing: [{ ...draftRow, storeId: 'S2', storeLabel: 'US shop', status: 'published' }] });
assert.ok(!ids(checks).includes('existing'), 'live in another store: not a problem for this one');
assert.ok(checks.find((c) => c.id === 'otherStores').text.includes("US shop (live on eBay)"), 'the otherStores message says: ' + "US shop (live on eBay)");

// a product that is already live: the markup of a new import means nothing, so a 0% markup is not called a loss
checks = L.buildChecks({ page: PAGE, server: { ...SERVER, existing: [{ ...draftRow, status: 'published' }] }, storeId: 'S1', settings: S, markup: 0, now: new Date('2026-03-10T12:00:00') });
assert.ok(!ids(checks).includes('profit'), 'no markup warning for a product that cannot be imported');
checks = L.buildChecks({ page: PAGE, server: { ...SERVER, existing: [{ ...draftRow, status: 'draft' }] }, storeId: 'S1', settings: S, markup: 0, now: new Date('2026-03-10T12:00:00') });
assert.strictEqual(level(checks, 'profit'), 'bad', 'a draft can be refreshed at a new markup: the warning stays');

// a live listing when Amazon's price moves
const live = { ...draftRow, status: 'published', sellPrice: 12.99, amazonPrice: 8 };
checks = withServer({ existing: [live] }, { ...PAGE, price: 11.5 });
assert.strictEqual(level(checks, 'livePrice'), 'bad', '11.50 cost against a 12.99 price: a loss after fees');
assert.ok(checks.find((c) => c.id === 'livePrice').text.includes("Amazon is now £11.50 (£8.00 when you listed). At your eBay price of £12.99 you now LOSE"), 'the livePrice message says: ' + "Amazon is now £11.50 (£8.00 when you listed). At your eBay price of £12.99 you now LOSE");
checks = withServer({ existing: [live] }, { ...PAGE, price: 9 });
assert.strictEqual(level(checks, 'livePrice'), 'warn', 'dearer but still a profit');
checks = withServer({ existing: [live] }, { ...PAGE, price: 7 });
assert.strictEqual(level(checks, 'livePrice'), 'info', 'cheaper: you keep more');
checks = withServer({ existing: [{ ...live, currency: 'USD' }] }, { ...PAGE, price: 11.5 });
assert.ok(!ids(checks).includes('livePrice'), 'prices in different currencies are not compared');

// the server was not reachable: the page checks still work
checks = L.buildChecks({ page: { ...PAGE, price: null }, server: null, storeId: null, settings: S, markup: 40 });
assert.deepStrictEqual(ids(checks).filter((i) => ['vero', 'existing', 'fit', 'credits'].includes(i)), []);
assert.strictEqual(level(checks, 'price'), 'bad');

console.log('extension logic tests passed');
