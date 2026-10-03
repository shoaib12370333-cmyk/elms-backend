// Admin Panel -> eBay rules: the admin sees what ELMS refuses to list (the built-in areas, each with its eBay policy page), can switch an area off, add
// words of their own and list phrases that are always fine, and can try a text before relying on it. The real routes, the real settings model and the
// real matcher run; MongoDB is a stand-in. The rows of the Drafts / Live listings pages carry the same warnings (policy_warnings).
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });
let doc = null; let saves = 0; let failSave = false;
stub('models/schemas/Settings', {
  findOne: () => ({ lean: async () => doc }),
  findOneAndUpdate: async (q, update) => { if (failSave) throw new Error('database is down'); saves += 1; doc = { ...(doc || {}), ...update }; return { toObject: () => doc }; },
});
const P = require('../services/prohibitedItemsService');
P.deps.isConnected = () => true;
const router = require('../routes/admin');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p + ' exists'); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (method, p, req = {}) => { const out = { status: 200 }; await handler(method, p)({ params: {}, body: {}, query: {}, ...req }, { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } }); return out; };

(async () => {
  // ---------- the page: every area with its terms and eBay page, the always-fine phrases, the admin's changes (none yet), the limits ----------
  let r = await call('get', '/ebay-policy');
  assert.deepStrictEqual([r.status, r.body.success], [200, true]);
  assert.strictEqual(r.body.areas.length, 11);
  const tobacco = r.body.areas.find((a) => a.id === 'tobacco');
  assert.deepStrictEqual([tobacco.label, tobacco.mediaExempt, tobacco.terms.includes('vape pen'), /^https:\/\/www\.ebay\.com\/help\//.test(tobacco.url)], ['Tobacco, e-cigarettes and vaping', true, true, true]);
  assert.strictEqual(r.body.areas.find((a) => a.id === 'counterfeit').mediaExempt, false);
  assert.ok(r.body.allowPhrases.includes('hidden camera detector') && r.body.allowPhrases.includes('thc free'));
  const weapons = r.body.areas.find((a) => a.id === 'weapons');
  assert.ok(weapons.contextRules.some((rule) => rule.terms.includes('nunchucks') && rule.unless.includes('wii') && rule.unless.includes('foam')), 'the page can say when a word is let through');
  assert.deepStrictEqual(r.body.areas.find((a) => a.id === 'explosives').contextRules, []);
  assert.deepStrictEqual(r.body.settings, { disabledAreas: [], extraTerms: [], allowPhrases: [] });
  assert.deepStrictEqual(r.body.limits, { extraTerms: 500, allowPhrases: 300, termLength: 60 });

  // ---------- the admin saves: an area off, a word of their own, a phrase that is fine ----------
  const input = { disabledAreas: ['pirated'], extraTerms: [{ area: 'custom', term: 'Zorp Widget' }, { area: 'weapons', term: 'war hammer' }], allowPhrases: ['practice taser prop'] };
  r = await call('put', '/ebay-policy', { body: input });
  assert.deepStrictEqual([r.status, r.body.success, saves], [200, true, 1]);
  assert.deepStrictEqual(r.body.settings, { disabledAreas: ['pirated'], extraTerms: [{ area: 'custom', term: 'zorp widget' }, { area: 'weapons', term: 'war hammer' }], allowPhrases: ['practice taser prop'] });
  assert.deepStrictEqual(r.body.ignored, { extraTerms: 0, allowPhrases: 0 });
  assert.deepStrictEqual(doc.ebayPolicy, r.body.settings, 'what is stored is the cleaned version');
  // ...and it applies at once to the rows and to the publish check (no waiting for a refresh)
  assert.deepStrictEqual(P.scanDetailed({ title: 'Cracked Software Keygen' }), [], 'pirated is off');
  assert.deepStrictEqual(P.scanDetailed({ title: 'Acme Zorp Widget' }).map((h) => h.areaId), ['custom']);
  assert.deepStrictEqual(P.scanDetailed({ title: 'Iron War Hammer' }).map((h) => h.areaId), ['weapons']);
  r = await call('get', '/ebay-policy');
  assert.deepStrictEqual(r.body.settings.disabledAreas, ['pirated'], 'the page shows what was saved');

  // junk is left out and counted, not stored and not an error
  r = await call('put', '/ebay-policy', { body: { disabledAreas: ['nope'], extraTerms: [{ area: 'custom', term: 'x' }, { area: 'ghost', term: 'valid term' }, { area: 'custom', term: 'ok term' }, { area: 'custom', term: 'OK  Term' }], allowPhrases: ['a', 'fine phrase'] } });
  assert.deepStrictEqual(r.body.settings, { disabledAreas: [], extraTerms: [{ area: 'custom', term: 'ok term' }], allowPhrases: ['fine phrase'] });
  assert.deepStrictEqual(r.body.ignored, { extraTerms: 3, allowPhrases: 1 });
  // a body of the wrong shape saves nothing
  const before = saves;
  for (const bad of [{ disabledAreas: 'tobacco' }, { extraTerms: { area: 'custom' } }, { allowPhrases: 'x' }]) {
    r = await call('put', '/ebay-policy', { body: bad });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /must be a list/);
  }
  assert.strictEqual(saves, before);
  // an empty body clears everything (nothing is "kept by accident")
  r = await call('put', '/ebay-policy', { body: {} });
  assert.deepStrictEqual(r.body.settings, { disabledAreas: [], extraTerms: [], allowPhrases: [] });
  // the database is down: an error, and the rules in use do not change
  P.setSettings({ disabledAreas: ['weapons'] });
  failSave = true;
  r = await call('put', '/ebay-policy', { body: { disabledAreas: [] } });
  assert.strictEqual(r.status, 500); assert.match(r.body.error, /Could not save/);
  assert.deepStrictEqual(P.currentSettings().disabledAreas, ['weapons'], 'a failed save changes nothing in use');
  failSave = false; P.setSettings({});

  // ---------- the tester: what the rules find in a text, with the saved changes or with changes not saved yet ----------
  r = await call('post', '/ebay-policy/test', { body: { title: 'Disposable Vape Pen', description: '<p>with Hidden Spy Camera</p>', bulletPoints: ['Durable'] } });
  assert.deepStrictEqual([r.status, r.body.success, r.body.blocked, r.body.hits.map((h) => h.areaId)], [200, true, true, ['tobacco', 'surveillance']]);
  assert.match(r.body.message, /^Not allowed on eBay \(Tobacco, e-cigarettes and vaping\): "vape pen" is in the title\./);
  r = await call('post', '/ebay-policy/test', { body: { title: 'Disposable Vape Pen', settings: { disabledAreas: ['tobacco'] } } });
  assert.deepStrictEqual([r.body.blocked, r.body.hits.length, r.body.message], [false, 0, ''], 'tried with a change that is not saved');
  assert.deepStrictEqual(P.currentSettings().disabledAreas, [], 'and nothing was saved by the test');
  r = await call('post', '/ebay-policy/test', { body: { title: 'The Cocaine Chronicles', categories: ['Books'] } });
  assert.strictEqual(r.body.blocked, false, 'the tester knows books are exempt');
  r = await call('post', '/ebay-policy/test', { body: { title: 'x'.repeat(5000) + ' vape pen' } });
  assert.strictEqual(r.body.blocked, false, 'the text is cut to the title length the tester accepts');
  r = await call('post', '/ebay-policy/test', { body: {} });
  assert.deepStrictEqual([r.status, r.body.blocked], [200, false]);

  // ---------- the rows of the pages: which policy and which word, besides the plain words of before ----------
  const origLoad = Module._load;
  Module._load = function (request, parent) { if (request === './schemas/Listing' && parent && /listingsModel\.js/.test(parent.filename)) return {}; return origLoad.apply(this, arguments); };
  const { serialize } = require('../models/listingsModel');
  Module._load = origLoad;
  const row = (obj) => serialize({ toObject: () => ({ _id: { toString: () => 'l1' }, ...obj }) });
  let s = row({ title: 'Stainless Steel Water Bottle' });
  assert.deepStrictEqual([s.policy_warning_terms, s.policy_warnings], [[], []], 'a clean listing: empty lists, never missing');
  s = row({ title: 'Glass Dab Rig Smoking Accessory' });
  assert.deepStrictEqual(s.policy_warning_terms, ['dab rig']);
  assert.deepStrictEqual(s.policy_warnings.map((w) => [w.area, w.label, w.terms, w.field]), [['drugs', 'Illegal drugs and drug paraphernalia', ['dab rig'], 'title']]);
  assert.ok(/^https:\/\/www\.ebay\.com\/help\//.test(s.policy_warnings[0].url) && s.policy_warnings[0].reason);
  s = row({ title: 'Disposable Vape Pen', description: 'also a Taser and a vape pen', bulletPoints: ['Hidden Spy Camera'], ebayAspects: { Type: ['Elf Bar'] } });
  assert.deepStrictEqual(s.policy_warnings.map((w) => w.area), ['tobacco', 'weapons', 'surveillance']);
  assert.deepStrictEqual(s.policy_warning_terms.sort(), ['elf bar', 'hidden spy', 'taser', 'vape pen']);
  P.setSettings({ disabledAreas: ['tobacco'] });
  assert.deepStrictEqual(row({ title: 'Disposable Vape Pen' }).policy_warnings, [], 'the admin\'s rules apply to the rows too');
  P.setSettings({});

  // a row of the pages = what the publish will decide: the imported text and the imported categories / brand count too
  const { withImportFallback } = require('../models/listingsModel');
  const withImport = (obj, product) => withImportFallback(row(obj), { sku: 'B0TEST', importId: { product } });
  let w = withImport({ title: 'Plain Charger' }, { asin: 'B0TEST', title: 'Plain Charger', description: 'works as a Taser', bulletPoints: [], specifications: [], ebayAspects: {} });
  assert.deepStrictEqual(w.policy_warnings.map((x) => [x.area, x.field]), [['weapons', 'description']], 'text taken from the import is scanned');
  w = withImport({ title: 'Heroin Chic: A Novel' }, { asin: 'B0TEST', categories: ['Books', 'Fiction'] });
  assert.deepStrictEqual([w.policy_warnings, w.policy_warning_terms], [[], []], 'a book about drugs: the row does not warn, the publish lets it through');
  w = withImport({ title: 'Heroin Chic Poster' }, { asin: 'B0TEST', categories: ['Home & Kitchen'] });
  assert.deepStrictEqual(w.policy_warnings.map((x) => x.area), ['drugs'], 'the same title outside the book categories warns');
  w = withImport({ title: 'Plain Charger' }, { asin: 'B0TEST', brand: 'Elf Bar' });
  assert.deepStrictEqual(w.policy_warnings.map((x) => [x.area, x.field]), [['tobacco', 'brand']], 'a brand alone is enough (the publish checks it)');
  w = withImport({ title: 'Plain Charger', description: 'the person wrote this', ebayAspects: { Type: ['Charger'] } }, { asin: 'B0TEST', title: 'Disposable Vape Pen', description: 'vape pen', ebayAspects: { Type: ['E-Liquid'] } });
  assert.deepStrictEqual(w.policy_warnings, [], 'what the person edited replaces the import, as it does at publish');

  console.log('admin ebay policy tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
