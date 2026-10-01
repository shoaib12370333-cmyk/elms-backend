// Live listings -> "Remove VeRO words" (bulk): unlike the Drafts bulk VeRO button (which only ever saves ELMS's own
// copy), a LIVE listing's cleaned title/description/aspects must actually reach eBay (reviseActiveListing) - this is
// what makes the removal real, not just cosmetic in ELMS. The real service and route run here; eBay, the AI clean
// step, credits and the database are stand-ins.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let words = ['nike'];
stub('services/veroSettingsService', { getVeroWordsOf: async () => words });

let cleanResult = null; // set per test: (input) => { data, usage } or throws
let cleanCalls = [];
stub('services/veroCleanerService', {
  cleanVeroTerms: async (input) => {
    cleanCalls.push(input);
    if (cleanResult instanceof Error) throw cleanResult;
    return cleanResult;
  },
});

let aiOn = true;
stub('models/settingsModel', { getAiSettings: async () => ({ aiTitleEnabled: aiOn }) });

let balance = 100;
const spends = []; const refunds = [];
stub('models/usersModel', {
  hasCredits: async (u, cost) => balance >= cost,
  spendCredit: async (u, cost) => { if (balance < cost) return false; balance -= cost; spends.push(cost); return true; },
  refundCredit: async (u, cost) => { balance += cost; refunds.push(cost); },
});

stub('config/actionCosts', { ACTION_COSTS: { AI_TITLE: 2 } });
stub('models/schemas/AiUsage', { create: async () => null });

const S = require('../services/liveBulkVeroService');

let rows = {};
const revises = []; // { token, args }
let reviseFail = new Set(); // offer ids eBay refuses
let tokens = { A1: 'tok1', A2: null };
const updates = []; // { id, fields }

S.deps.revise = async (token, args) => {
  revises.push({ token, args });
  if (reviseFail.has(args.offerId)) throw new Error('A category ID is invalid (eBay error 21916984)');
  return { live: null };
};

const live = (n, over = {}) => ({
  id: 'L' + n, title: 'Nike Running Shoes ' + n, description: 'Genuine Nike shoes, size ' + n,
  bullet_points: [], specifications: [],
  sku: 'B0' + n, status: 'published', ebay_offer_id: 'O' + n, ebay_account_id: 'A1',
  sell_price: 29.99, currency: 'USD', quantity: 3, category_id: '15709', ebay_aspects: { Brand: ['Nike'] },
  ...over,
});
const reset = (count = 3) => {
  rows = {}; for (let i = 1; i <= count; i++) rows['L' + i] = live(i);
  revises.length = 0; reviseFail = new Set(); tokens = { A1: 'tok1', A2: null }; updates.length = 0;
  balance = 100; spends.length = 0; refunds.length = 0; cleanCalls.length = 0; aiOn = true; words = ['nike'];
  cleanResult = { data: { title: 'Running Shoes', description: 'Genuine running shoes', bulletPoints: [], specifications: [], aspects: { Brand: ['Unbranded'] }, removed: ['nike'] }, usage: { model: 'x', inputTokens: 1, outputTokens: 1 } };
};
const deps = {
  getListingsByIds: async (u, ids) => new Map(ids.filter((id) => rows[id]).map((id) => [id, JSON.parse(JSON.stringify(rows[id]))])),
  updateListing: async (u, id, fields) => { updates.push({ id, fields }); if (rows[id]) Object.assign(rows[id], { title: fields.title, description: fields.description, bullet_points: fields.bulletPoints, specifications: fields.specifications, ebay_aspects: fields.ebayAspects }); return rows[id] || null; },
  getRefreshToken: async (u, account) => tokens[account],
};
const run = async (ids) => S.bulkVeroCleanLive({ userId: 'u1', ids }, deps);

(async () => {
  // ---------- a few live listings with VeRO words, cleaned and pushed to eBay ----------
  reset(3);
  let out = await run(['L1', 'L2', 'L3']);
  assert.deepStrictEqual(out.summary, { changed: 3, clean: 0, skipped: 0, failed: 0, no_credits: 0 });
  assert.strictEqual(revises.length, 3);
  assert.deepStrictEqual(revises.map((r) => r.args.offerId).sort(), ['O1', 'O2', 'O3']);
  assert.ok(revises.every((r) => r.token === 'tok1' && r.args.title === 'Running Shoes' && r.args.description === 'Genuine running shoes'));
  // only the Brand aspect actually changed (Nike -> Unbranded), so only that key is sent to eBay
  assert.deepStrictEqual(revises[0].args.aspects, { Brand: ['Unbranded'] });
  // the existing price/quantity/category are carried through unchanged (reviseActiveListing requires them)
  assert.deepStrictEqual([revises[0].args.sellPrice, revises[0].args.quantity, revises[0].args.categoryId], [29.99, 3, '15709']);
  assert.strictEqual(updates.length, 3);
  assert.deepStrictEqual(rows.L1.ebay_aspects, { Brand: ['Unbranded'] });
  assert.strictEqual(spends.length, 3, 'one credit per listing actually cleaned');
  assert.strictEqual(balance, 100 - 3 * 2);
  assert.ok(out.results.every((r) => r.status === 'changed' && r.removed.includes('nike')));

  // ---------- which listings are skipped, and why ----------
  reset(5);
  rows.L1.status = 'draft'; // not live
  rows.L2.ebay_offer_id = null;
  rows.L3.ebay_account_id = 'A2'; tokens.A2 = null; // store missing its connection
  rows.L4.title = 'Plain running shoes'; rows.L4.description = 'No protected words here'; rows.L4.ebay_aspects = {}; // no VeRO words at all
  out = await run(['L1', 'L2', 'L3', 'L4', 'L5', 'NOPE']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'clean', 'changed', 'skipped']);
  assert.match(out.results[0].reason, /Only a live/);
  assert.match(out.results[1].reason, /no eBay offer/);
  assert.match(out.results[2].reason, /Reconnect/);
  assert.match(out.results[3].reason, /No VeRO words/);
  assert.match(out.results[5].reason, /Not found/);
  assert.strictEqual(revises.length, 1, 'eBay is only called for the one that really needed cleaning');
  assert.strictEqual(spends.length, 1, 'no credit spent for a listing with nothing to clean');

  // a sold-out (still-live) listing is cleaned too, not just "published"
  reset(1); rows.L1.status = 'sold';
  out = await run(['L1']);
  assert.deepStrictEqual(out.summary, { changed: 1, clean: 0, skipped: 0, failed: 0, no_credits: 0 });

  // ---------- not enough credits: skipped before any AI call or eBay call, nothing charged ----------
  reset(2); balance = 1; // less than the cost (2)
  out = await run(['L1', 'L2']);
  assert.ok(out.results.every((r) => r.status === 'no_credits' && /Not enough credits/.test(r.reason)));
  assert.strictEqual(cleanCalls.length, 0); assert.strictEqual(revises.length, 0);

  // ---------- the AI switch is off: the whole call is refused up front ----------
  reset(1); aiOn = false;
  await assert.rejects(() => run(['L1']), (err) => { assert.strictEqual(err.statusCode, 403); return true; });

  // ---------- the AI clean step fails: the credit is refunded, nothing reaches eBay ----------
  reset(1); cleanResult = new Error('The AI answer could not be read. Please try again.');
  out = await run(['L1']);
  assert.deepStrictEqual(out.summary, { changed: 0, clean: 0, skipped: 0, failed: 1, no_credits: 0 });
  assert.match(out.results[0].reason, /AI answer could not be read/);
  assert.strictEqual(revises.length, 0);
  assert.strictEqual(balance, 100, 'the spent credit came back');

  // ---------- the AI leaves only a protected word as the title: refused and refunded, not sent to eBay ----------
  reset(1); cleanResult = { data: { title: '', description: 'x', aspects: {}, removed: ['nike'] }, usage: null };
  out = await run(['L1']);
  assert.match(out.results[0].reason, /only a protected word/);
  assert.strictEqual(revises.length, 0);
  assert.strictEqual(balance, 100);

  // ---------- a VeRO word hiding only in bullet points or specifications is no longer wrongly marked "clean": before
  // this fix, the live clean action never looked at or saved those two fields, so a listing whose only VeRO word was
  // there kept counting as a VeRO listing forever, no matter how many times it was "cleaned" ----------
  reset(1);
  rows.L1.title = 'Running shoes'; rows.L1.description = 'Comfortable running shoes'; rows.L1.ebay_aspects = {};
  rows.L1.bullet_points = ['Genuine Nike quality', 'Breathable mesh'];
  rows.L1.specifications = [{ name: 'Brand', value: 'Nike' }];
  cleanResult = {
    data: {
      title: 'Running shoes', description: 'Comfortable running shoes', aspects: {},
      bulletPoints: ['Genuine quality', 'Breathable mesh'], specifications: [{ name: 'Brand', value: 'Unbranded' }],
      removed: ['nike'],
    },
    usage: { model: 'x', inputTokens: 1, outputTokens: 1 },
  };
  out = await run(['L1']);
  assert.deepStrictEqual(out.summary, { changed: 1, clean: 0, skipped: 0, failed: 0, no_credits: 0 }, 'a word hiding only in bullet points/specifications is still found, not skipped as already clean');
  assert.deepStrictEqual(cleanCalls[0].bulletPoints, ['Genuine Nike quality', 'Breathable mesh'], 'bullet points are sent to the AI cleaner too');
  assert.deepStrictEqual(cleanCalls[0].specifications, [{ name: 'Brand', value: 'Nike' }], 'specification rows are sent too');
  assert.deepStrictEqual(updates[0].fields.bulletPoints, ['Genuine quality', 'Breathable mesh'], 'the cleaned bullet points are saved to ELMS\'s own copy');
  assert.deepStrictEqual(updates[0].fields.specifications, [{ name: 'Brand', value: 'Unbranded' }], 'the cleaned specification rows are saved to ELMS\'s own copy');
  assert.strictEqual(revises[0].args.bulletPoints, undefined, 'bullet points/specifications are never pushed to eBay on their own - eBay has no such field');
  assert.strictEqual(revises[0].args.specifications, undefined);

  // ---------- eBay refuses one listing: skipped with eBay's own words, the credit is refunded, others still go through ----------
  reset(3); reviseFail = new Set(['O2']);
  out = await run(['L1', 'L2', 'L3']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'failed', 'changed']);
  assert.match(out.results[1].reason, /category ID is invalid/);
  assert.strictEqual(rows.L2.title, 'Nike Running Shoes 2', 'ELMS is not touched when eBay refused the update');
  assert.strictEqual(balance, 100 - 2 * 2, 'the refused listing\'s credit came back');

  // ---------- the route: at most 20 ids, one id twice is one listing ----------
  reset(2);
  const noop = async () => null;
  const fakes = {
    '../models/listingsModel': { listListings: noop, getListingById: noop, getListingsByIds: deps.getListingsByIds, updateListing: deps.updateListing, updateListingStats: noop, updateListingSettings: noop, restockListing: noop },
    '../services/ebayStatsService': { fetchItemTraffic: noop },
    '../services/listingStatsService': { syncStatsForAccount: noop },
    '../services/ebayListingService': { reviseActiveListing: noop, fetchLiveListing: noop, createOrGetCustomLocation: noop, publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop },
    '../services/publishQueueService': { processOneQueuedListing: noop },
    '../models/ebayAccountsModel': { listEbayAccounts: noop, getEbayAccountById: noop, getEbayAccountRefreshToken: async (u, a) => tokens[a] },
    '../models/importsModel': { getImportById: noop },
    '../services/publishPreflightService': { checkAspects: noop },
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../services/publishRunner': { enqueuePublish: noop },
    '../models/usersModel': { hasCredits: noop, spendCredit: noop, refundCredit: noop, getPricingRule: async () => null },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]listings\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/listings');
  Module._load = orig;
  const h = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/bulk-vero-clean' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await h({ userId: 'u1', body }, res); return res; };

  let res = await call({ ids: [] });
  assert.strictEqual(res.statusCode, 400);
  res = await call({ ids: Array.from({ length: 21 }, (_, i) => 'X' + i) });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 20/);
  res = await call({ ids: ['L1', 'L1', 'L2'] });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.results.length, res.body.summary.changed], [200, true, 2, 2], 'the same id twice is one listing');

  console.log('live bulk vero clean: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
