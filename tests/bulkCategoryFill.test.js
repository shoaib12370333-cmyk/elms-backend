// "Fill category with AI" for the selected drafts: each draft that has NO category gets one chosen by the AI from the category list of ITS OWN eBay site
// (a US store's draft from the US list, a UK store's draft from the UK list), saved on the draft, charged the admin-set AI_CATEGORY credits. A draft that
// already has a category, is not a draft, has no title, has no known eBay site (never guessed as US) or has no uploaded list for its site is left alone and
// not charged; the AI failing gives the credits back; when the balance runs out the rest are not attempted. The real fill, pick and list code run.
const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

// ---- the category lists: the SAME product has a different category number on each eBay site ----
const csvOf = (kettle, other) => 'CategoryID,Category Path\r\n' + [kettle, ...other].join('\r\n') + '\r\n' + Array.from({ length: 30 }, (_, i) => (7000 + i) + ',"Filler > Group ' + i + ' > Thing ' + i + '"').join('\r\n') + '\r\n';
const stored = new Map();
stub('models/schemas/EbayCategoryList', {
  findOneAndUpdate: async (q, u) => { stored.set(q.marketplaceId, { marketplaceId: q.marketplaceId, ...u.$set, updatedAt: new Date() }); },
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  findOne: (q) => { const row = stored.get(q.marketplaceId) || null; return { select: () => ({ lean: async () => (row ? { updatedAt: row.updatedAt } : null) }), then: (res, rej) => Promise.resolve(row).then(res, rej) }; },
  deleteOne: async () => ({ deletedCount: 0 }),
});

// ---- the AI: chooses the first category of the list it is shown, and says which site the list was for ----
const asked = [];
let aiFails = false;
stub('services/aiService', { aiConfigured: () => true, askClaude: async (o) => {
  asked.push(o.prompt);
  if (aiFails) throw Object.assign(new Error('The AI service could not be reached.'), { statusCode: 502 });
  const first = o.prompt.split('Categories:\n')[1].split('\n')[0].split(' | ')[0];
  return { text: '{"id":"' + first + '"}', model: 'claude-test', inputTokens: 500, outputTokens: 10 };
} });
stub('models/settingsModel', { getAiSettings: async () => ({ aiCategoryEnabled: true }) });
stub('services/ebayTaxonomyService', { suggestCategories: async () => { throw new Error('the bulk fill must not ask eBay'); } });
let balance = 100;
stub('models/usersModel', { spendCredit: async (u, cost) => { if (balance < cost) return false; balance -= cost; return true; }, refundCredit: async (u, cost) => { balance += cost; } });
const usageRows = [];
stub('models/schemas/AiUsage', { create: (row) => { usageRows.push(row); return Promise.resolve(); } });

// ---- the drafts ----
const drafts = {};
const saves = [];
stub('models/listingsModel', {
  getListingById: async (u, id) => drafts[id] || null,
  updateListing: async (u, id, fields) => { saves.push({ id, fields }); drafts[id].category_id = fields.categoryId; },
});
stub('models/ebayAccountsModel', { getEbayAccountById: async (u, id) => ({ A_UK: { marketplaceId: 'EBAY_GB' }, A_US: { marketplaceId: 'EBAY_US' }, A_NONE: {} }[id] || null) });

const { ACTION_COSTS } = require('../config/actionCosts');
const L = require('../services/categoryListService');
const { fillDraftCategory, fillManyDraftCategories } = require('../services/categoryFillService');
const draft = (id, over = {}) => { drafts[id] = { id, title: 'Stainless Steel Electric Kettle 1.7L', status: 'draft', category_id: null, marketplace_id: null, ebay_account_id: null, ...over }; return id; };
const { _picks } = require('../services/aiCategoryService');
const reset = () => { _picks.clear(); asked.length = 0; saves.length = 0; usageRows.length = 0; balance = 100; aiFails = false; ACTION_COSTS.AI_CATEGORY = 3; Object.keys(drafts).forEach((k) => delete drafts[k]); };

(async () => {
  await L.saveCategoryList('EBAY_US', csvOf('111,"Home & Garden > Kitchen > Small Appliances > Tea Kettles"', ['112,"Home & Garden > Kitchen > Coffee Makers"']));
  await L.saveCategoryList('EBAY_GB', csvOf('222,"Home, Furniture & DIY > Kitchen > Kettles"', ['223,"Home, Furniture & DIY > Kitchen > Coffee Machines"']));

  // ---- each draft uses the list of its own eBay site ----
  reset();
  draft('uk', { marketplace_id: 'EBAY_GB' });
  draft('us', { marketplace_id: 'EBAY_US' });
  draft('uk-by-store', { ebay_account_id: 'A_UK' }); // no site on the draft: its store's site
  draft('us-by-store', { ebay_account_id: 'A_US', title: 'Glass Coffee Maker Machine' });
  const uk = await fillDraftCategory('u1', 'uk');
  const us = await fillDraftCategory('u1', 'us');
  assert.deepStrictEqual([uk.status, uk.categoryId, uk.creditsUsed], ['filled', '222', 3], 'a UK store gets its category from the UK list');
  assert.strictEqual(uk.categoryPath, 'Home, Furniture & DIY > Kitchen > Kettles');
  assert.deepStrictEqual([us.status, us.categoryId, us.creditsUsed], ['filled', '111', 3], 'a US store gets its category from the US list');
  assert.ok(asked[0].includes('eBay site: ebay.co.uk') && asked[0].includes('222 |') && !asked[0].includes('111 |'), 'the UK draft was only shown UK categories');
  assert.ok(asked[1].includes('eBay site: ebay.com') && asked[1].includes('111 |') && !asked[1].includes('222 |'), 'the US draft was only shown US categories');
  assert.deepStrictEqual(saves, [{ id: 'uk', fields: { categoryId: '222' } }, { id: 'us', fields: { categoryId: '111' } }]);
  assert.strictEqual(balance, 94);
  const byStore = await fillDraftCategory('u1', 'uk-by-store');
  assert.deepStrictEqual([byStore.categoryId, byStore.creditsUsed], ['222', 0], "the draft's store decides when the draft has no site of its own (and the same words as the first UK draft are free)");
  assert.strictEqual((await fillDraftCategory('u1', 'us-by-store')).categoryId, '112');
  assert.strictEqual(usageRows.length, 3); assert.ok(usageRows.every((r) => r.kind === 'category' && r.ok && r.credits === 3));

  // ---- left alone, not charged ----
  reset();
  draft('has', { marketplace_id: 'EBAY_GB', category_id: '9355' });
  draft('live', { marketplace_id: 'EBAY_GB', status: 'published' });
  draft('notitle', { marketplace_id: 'EBAY_GB', title: '  ' });
  draft('nosite'); // no site, no store
  draft('nosite2', { ebay_account_id: 'A_NONE' }); // a store without a site
  draft('nolist', { marketplace_id: 'EBAY_DE' }); // nobody uploaded the German list
  const out = {};
  for (const id of ['has', 'live', 'notitle', 'nosite', 'nosite2', 'nolist', 'ghost']) out[id] = await fillDraftCategory('u1', id);
  assert.strictEqual(out.has.status, 'has_category'); assert.strictEqual(drafts.has.category_id, '9355', 'a category that is there is never replaced');
  assert.strictEqual(out.live.status, 'skipped'); assert.match(out.live.reason, /Only drafts/);
  assert.strictEqual(out.notitle.status, 'skipped'); assert.match(out.notitle.reason, /no title/);
  assert.strictEqual(out.nosite.status, 'skipped'); assert.match(out.nosite.reason, /Could not tell which eBay site/);
  assert.strictEqual(out.nosite2.status, 'skipped'); assert.match(out.nosite2.reason, /Could not tell which eBay site/);
  assert.strictEqual(out.nolist.status, 'skipped'); assert.match(out.nolist.reason, /No category list is uploaded for ebay\.de/);
  assert.deepStrictEqual([out.ghost.status, out.ghost.reason], ['skipped', 'Not found.']);
  assert.deepStrictEqual([asked.length, saves.length, balance], [0, 0, 100], 'nothing asked, nothing saved, nothing charged');
  assert.ok(Object.values(out).every((r) => r.creditsUsed === 0));

  // ---- the AI fails: credits back, a reason, nothing saved ----
  reset(); aiFails = true; draft('d', { marketplace_id: 'EBAY_GB' });
  const failed = await fillDraftCategory('u1', 'd');
  assert.strictEqual(failed.status, 'failed'); assert.match(failed.reason, /could not be reached/); assert.deepStrictEqual([balance, saves.length, failed.creditsUsed], [100, 0, 0]);

  // ---- credits run out: the rest are not attempted ----
  reset(); balance = 6;
  ['a', 'b', 'c', 'd'].forEach((id, i) => draft(id, { marketplace_id: 'EBAY_GB', title: 'Kettle ' + ['alpha', 'bravo', 'charlie', 'delta'][i] + ' stainless' })); // different words each: none is a free repeat
  const many = await fillManyDraftCategories('u1', ['a', 'b', 'c', 'd'], { concurrency: 1 });
  assert.deepStrictEqual(many.map((r) => r.status), ['filled', 'filled', 'no_credits', 'no_credits']);
  assert.strictEqual(asked.length, 2, 'the AI was not asked for the ones there was no money for'); assert.strictEqual(balance, 0);
  assert.deepStrictEqual(many.map((r) => r.id), ['a', 'b', 'c', 'd'], 'the answers are in the order asked');

  // ---- the same product words: asked once, the repeat is free ----
  reset();
  draft('r1', { marketplace_id: 'EBAY_GB' }); draft('r2', { marketplace_id: 'EBAY_GB' });
  const rep1 = await fillDraftCategory('u1', 'r1'); const rep2 = await fillDraftCategory('u1', 'r2');
  assert.deepStrictEqual([rep1.creditsUsed, rep2.creditsUsed, rep2.categoryId, asked.length, balance], [3, 0, '222', 1, 97]);

  // ---- free when the admin sets 0 ----
  reset(); ACTION_COSTS.AI_CATEGORY = 0; draft('f', { marketplace_id: 'EBAY_US', title: 'Coffee Maker Glass Carafe' });
  const free = await fillDraftCategory('u1', 'f'); assert.deepStrictEqual([free.status, free.creditsUsed, balance], ['filled', 0, 100]);

  console.log('bulk category fill tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
