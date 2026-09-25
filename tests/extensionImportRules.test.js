// Extension 3.7 import rules: the price is shown as the admin set it (0 = Free), no eBay store is a warning (not a stop) when ELMS allows it,
// and a loss or any other warning never stops an import. The checks are the real extension/logic.js; the "what stops an import" part reads the
// real content.js / popup.js source, so a later change that makes a warning block an import fails here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../extension/logic');

const S = L.normalizeSettings({});
const ids = (checks) => checks.map((c) => c.id);
const level = (checks, id) => (checks.find((c) => c.id === id) || {}).level;
const text = (checks, id) => (checks.find((c) => c.id === id) || {}).text;
const STORE_UK = { id: 'S1', label: 'Trendy UK', marketplaceId: 'EBAY_GB', currency: 'GBP', isActive: true, amazonOk: true, amazonMessage: null };
const SERVER = { credits: { balance: 40, unlimited: false, importCost: 1, bulkImportCost: 1 }, policy: { importWithoutStore: true }, stores: [STORE_UK], existing: [], vero: { enabled: true, terms: [], fields: {} } };
const PAGE = { price: 8, currency: 'GBP', unavailable: false, hasCart: true, soldBy: 'Amazon', amazonSold: true, fulfilledByAmazon: true, deliveryText: 'FREE delivery Thursday, 12 March', rating: 4.5, ratingCount: 300, imageCount: 7, variantCount: 1 };
const withServer = (patch, markup = 60) => L.buildChecks({ page: PAGE, server: { ...SERVER, ...patch }, storeId: 'S1', settings: S, markup, now: new Date('2026-03-10T12:00:00') });

// ---- prices the way people read them ----
assert.strictEqual(L.costLabel(0), 'Free');
assert.strictEqual(L.costLabel(1), '1 credit');
assert.strictEqual(L.costLabel(2), '2 credits');
assert.strictEqual(L.costLabel(120), '120 credits');
assert.strictEqual(L.costLabel(undefined), '');
assert.strictEqual(L.costLabel(null), '');
assert.strictEqual(L.costLabel(-1), '');
assert.strictEqual(L.costLabel('3'), '3 credits');

// a draft that is refreshed: the message follows the price
const draftRow = { id: 'L1', status: 'draft', storeId: 'S1', storeLabel: 'Trendy UK', sellPrice: 12.99, amazonPrice: 8, currency: 'GBP' };
assert.match(text(withServer({ existing: [draftRow], credits: { balance: 40, unlimited: false, importCost: 0 } }), 'existing'), /Importing again refreshes it \(free\)\./);
assert.match(text(withServer({ existing: [draftRow], credits: { balance: 40, unlimited: false, importCost: 1 } }), 'existing'), /refreshes it and costs 1 credit\./);
assert.match(text(withServer({ existing: [draftRow], credits: { balance: 40, unlimited: false, importCost: 3 } }), 'existing'), /refreshes it and costs 3 credits\./);

// a free import needs no credits: none left is not a problem; a price with none left is
assert.ok(!ids(withServer({ credits: { balance: 0, unlimited: false, importCost: 0 } })).includes('credits'));
assert.strictEqual(level(withServer({ credits: { balance: 0, unlimited: false, importCost: 2 } }), 'credits'), 'bad');

// ---- no eBay store ----
// an older ELMS says nothing about the policy: a stop, as before
assert.strictEqual(level(withServer({ stores: [], policy: undefined }), 'store'), 'bad');
// the admin switched it off: a stop that says what to do
let checks = withServer({ stores: [], policy: { importWithoutStore: false } });
assert.strictEqual(level(checks, 'store'), 'bad');
assert.match(text(checks, 'store'), /Connect one in ELMS first/);
// allowed: a warning that says the import still works
checks = withServer({ stores: [], policy: { importWithoutStore: true } });
assert.strictEqual(level(checks, 'store'), 'warn');
assert.match(text(checks, 'store'), /You can still import: the draft is saved without a store\. Connect a store in ELMS before you publish it\./);
// with a store the switch is irrelevant, and a store on the wrong Amazon site is still a stop
assert.ok(!ids(withServer({ policy: { importWithoutStore: true } })).includes('store'));
assert.strictEqual(level(withServer({ stores: [{ ...STORE_UK, amazonOk: false, amazonMessage: 'Use amazon.co.uk.' }] }), 'fit'), 'bad');

// ---- a loss is only a warning about the price ----
checks = withServer({}, 0);
assert.strictEqual(level(checks, 'profit'), 'warn', 'shown as an amber warning, not a red error');
assert.match(text(checks, 'profit'), /you lose/);
assert.strictEqual(L.worstLevel(checks), 'warn', 'the chip is amber for a loss (nothing else is wrong with this product)');
// a live listing that now loses, and "cannot make money at eBay prices", are warnings too
const liveRow = { id: 'L2', status: 'published', storeId: 'S1', storeLabel: 'Trendy UK', sellPrice: 12.99, amazonPrice: 8, currency: 'GBP' };
assert.strictEqual(level(L.buildChecks({ page: { ...PAGE, price: 11.5 }, server: { ...SERVER, existing: [liveRow] }, storeId: 'S1', settings: S, markup: 0, now: new Date('2026-03-10T12:00:00') }), 'livePrice'), 'warn');
assert.strictEqual(level(L.buildChecks({ page: { ...PAGE, price: 14 }, server: SERVER, storeId: 'S1', settings: S, markup: 60, market: { available: true, exact: true, total: 137, count: 30, currency: 'GBP', min: 9.99, median: 13.49, max: 24 }, now: new Date('2026-03-10T12:00:00') }), 'market'), 'warn');
// no check about money is an error (only real problems are: no price, unavailable, VeRO, not enough credits, already live, wrong Amazon site, no store when not allowed)
const moneyIds = ['profit', 'market', 'livePrice'];
for (const c of [...checks, ...withServer({}, 10), ...withServer({}, 30)]) assert.ok(!(moneyIds.includes(c.id) && c.level === 'bad'), c.id + ' must not be an error');

// ---- what STOPS an import (the real source of the panel and the bulk panel) ----
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const between = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a > 0 && b > a, 'found ' + from); return src.slice(a, b); };
const single = between('function importBlock()', 'function compute()');
const bulk = between('function bulkBlock()', 'function renderBulk()');
for (const [name, body] of [['importBlock', single], ['bulkBlock', bulk]]) {
  assert.ok(!/profit|loss|vero|warn|checks|level|worst/i.test(body), name + ' must not look at warnings: a loss / VeRO word / slow delivery never stops an import');
  assert.match(body, /S\.connected/, name + ' stops when ELMS is not connected');
  assert.match(body, /not have enough credits|need .* credits/, name + ' stops when the credits do not cover the price');
  assert.match(body, /amazonOk === false/, name + ' stops for an Amazon site that does not fit the store');
  assert.match(body, /!storeless\(\)/, name + ' lets a person with no store import when ELMS allows it');
}
assert.match(single, /Already /, 'a product that is already live cannot be imported again');
assert.match(src, /source: 'extension'/, 'the extension bulk import asks for the extension price');
assert.match(src, /bulkImportCost != null/, 'a bulk price of 0 stays 0 (it used to become 1)');
assert.ok(!/bulkImportCost\) \|\| 1/.test(src), 'no more "|| 1" on the bulk price');
assert.match(src, /LOGIC\.costLabel\(credits\.importCost\)/, 'the button shows the price as set');
assert.match(src, /importLossNote\(\)/, 'a loss is repeated after the import');
assert.ok(!/'Loss '/.test(src), 'the chip no longer says a red "Loss"');
assert.match(src, /lossy\s*\?\s*'⚠ '/, 'a loss makes the chip say "⚠ N warnings"');
const popup = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
assert.match(popup, /credits\.importCost === 0/, 'the popup says "free" for a price of 0');

// ---- the version moved, so Chrome offers the update ----
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.version, '3.7.1');

console.log('extension import rules tests passed');
