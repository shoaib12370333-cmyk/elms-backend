// The description beautifier: restructures a seller's OWN description into their saved Description Template
// (services/descriptionTemplateLibrary.js + services/descriptionBeautifyService.js) - AI writes the fact-based
// blocks (bullets, specs...), real seller data (gallery images, store banner, size chart, video, custom HTML) is
// spliced in afterwards so the AI never invents it. Single-item route (routes/listOnEbay.js) never saves by
// itself (same as "Generate Description With AI"); the bulk route (routes/listings.js) saves and charges credits
// per draft, same shape as bulk-aspects.
const assert = require('assert');
const path = require('path');

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};

const store = {};
const saved = {};
let balance = 100;
const spent = [];
const refunded = [];
let templates = {};
let aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
let aiCalls = 0;
let aiFails = false;
let aiEnabled = true;

stub('models/listingsModel', {
  getListingById: async (u, id) => (u === 'u1' ? store[id] || null : null),
  updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; },
});
stub('models/usersModel', {
  hasCredits: async (u, cost) => cost <= 0 || balance >= cost,
  spendCredit: async (u, cost) => { if (balance < cost) return false; balance -= cost; spent.push(cost); return true; },
  refundCredit: async (u, cost) => { balance += cost; refunded.push(cost); return true; },
  getDescriptionTemplate: async (u) => templates[u] || null,
  setDescriptionTemplate: async (u, t) => { templates[u] = t; return t; },
  setAutoOrderSettings: async () => ({}),
});
stub('models/schemas/AiUsage', { create: async () => ({}) });
stub('models/settingsModel', { getAiSettings: async () => ({ aiBeautifyDescriptionEnabled: aiEnabled, aiCustomInstructions: '' }) });
stub('services/aiService', { askClaude: async () => { aiCalls += 1; if (aiFails) throw new Error('AI is down'); return { text: aiAnswer, model: 'test', inputTokens: 1, outputTokens: 1 }; } });

const { ACTION_COSTS } = require('../config/actionCosts');
const { normalizeTemplate, TEMPLATE_STYLES, AVAILABLE_BLOCKS } = require('../services/descriptionTemplateLibrary');
const { beautifyEbayDescription, beautifyDraftDescription, beautifyManyDraftDescriptions } = require('../services/descriptionBeautifyService');
const listingsRouter = require('../routes/listings');
const listOnEbayRouter = require('../routes/listOnEbay');
const sellerSettingsRouter = require('../routes/sellerSettings');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, method, p, body, userId = 'u1') => { const res = fakeRes(); await handler(router, method, p)({ userId, body: body || {} }, res); return res; };

const draft = (id, extra = {}) => ({ id, status: 'draft', title: 'Acme Running Shoes ' + id, description: 'Black running shoes.', bullet_points: ['Black mesh'], specifications: [], images: ['https://a.com/1.jpg'], ...extra });
const reset = () => { for (const k of Object.keys(saved)) delete saved[k]; spent.length = 0; refunded.length = 0; aiCalls = 0; aiFails = false; };

(async () => {
  // ---------- normalizeTemplate: never throws, always usable ----------
  let t = normalizeTemplate(null);
  assert.strictEqual(t.templateId, TEMPLATE_STYLES[0].id);
  assert.deepStrictEqual(t.blocks, TEMPLATE_STYLES[0].defaultBlocks);
  assert.strictEqual(t.branding.accentColor, '#111111');

  t = normalizeTemplate({ templateId: 'not-a-real-style', blocks: ['bullets', 'not-a-real-block', 'specs'] });
  assert.strictEqual(t.templateId, TEMPLATE_STYLES[0].id, 'an unknown style falls back to the first one');
  assert.deepStrictEqual(t.blocks, ['bullets', 'specs'], 'an unknown block key is dropped');

  t = normalizeTemplate({ templateId: 'tech', branding: { logoUrl: 'not a url', accentColor: 'not a color', storeName: 'Acme' } });
  assert.strictEqual(t.templateId, 'tech');
  assert.strictEqual(t.branding.logoUrl, '', 'a non-http logo URL is dropped');
  assert.strictEqual(t.branding.accentColor, '#111111', 'an invalid color falls back to the default');
  assert.strictEqual(t.branding.storeName, 'Acme');

  t = normalizeTemplate({ videoUrl: 'https://youtube.com/x', sizeChartHtml: '<table></table>' });
  assert.strictEqual(t.videoUrl, 'https://youtube.com/x');
  assert.strictEqual(t.sizeChartHtml, '<table></table>');

  // ---------- beautifyEbayDescription: AI writes the fact blocks, real data fills the rest ----------
  aiAnswer = '```html\n<h2>Key Features</h2><ul><li>Black mesh</li></ul>\n{{ELMS_GALLERY}}\n{{ELMS_STORE_BANNER}}\n{{ELMS_CUSTOM_HTML}}\n```';
  let out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'], images: ['https://a.com/1.jpg'],
    template: { templateId: 'minimal', blocks: ['bullets', 'gallery', 'store_banner', 'custom_html'], branding: { storeName: 'Acme Deals', logoUrl: '', accentColor: '#111111' }, customHtml: 'Why buy from us', sizeChartHtml: '', videoUrl: '' },
  });
  assert.ok(!out.text.includes('```'), 'the markdown fence is stripped');
  assert.ok(!out.text.includes('{{ELMS_'), 'no raw placeholder is ever left in the saved description');
  assert.ok(out.text.includes('https://a.com/1.jpg'), 'the listing\'s own real image is spliced in - never invented by the AI');
  assert.ok(out.text.includes('Acme Deals'), 'the seller\'s own store name is spliced in');
  assert.ok(out.text.includes('Why buy from us'), 'the seller\'s own custom HTML is spliced in');

  // a data block with nothing behind it is removed cleanly, not left as an empty gap or a literal token
  aiAnswer = '<p>Facts</p>{{ELMS_GALLERY}}{{ELMS_VIDEO}}';
  out = await beautifyEbayDescription({ title: 'X', images: [], template: { templateId: 'minimal', blocks: ['gallery', 'video'], branding: {}, videoUrl: '' } });
  assert.strictEqual(out.text, '<p>Facts</p>', 'no images and no video URL: both placeholders vanish, nothing invented');

  // an empty/too-short AI answer is a hard failure, never saved as a real description
  aiAnswer = 'hi';
  await assert.rejects(() => beautifyEbayDescription({ title: 'X', template: {} }), /empty description/);

  // ---------- beautifyDraftDescription: charges credits, saves, mirrors fillDraftAspects ----------
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>{{ELMS_GALLERY}}';
  ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 2;
  reset(); balance = 100;
  store.a = draft('a');
  let r = await beautifyDraftDescription('u1', 'a', normalizeTemplate({ blocks: ['bullets', 'gallery'] }));
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.creditsUsed, 2);
  assert.ok(saved.a.description.includes('https://a.com/1.jpg'));
  assert.deepStrictEqual(spent, [2]);

  reset();
  store.b = draft('b', { status: 'published' });
  r = await beautifyDraftDescription('u1', 'b', normalizeTemplate());
  assert.strictEqual(r.status, 'skipped');
  assert.match(r.reason, /Only drafts/);

  r = await beautifyDraftDescription('u1', 'nope', normalizeTemplate());
  assert.strictEqual(r.status, 'skipped');

  store.noTitle = draft('noTitle', { title: 'ab' });
  r = await beautifyDraftDescription('u1', 'noTitle', normalizeTemplate());
  assert.strictEqual(r.status, 'skipped');
  assert.match(r.reason, /no title/);

  assert.strictEqual(aiCalls, 0, 'the AI is never called for a skipped draft');

  // ---------- the AI is down: credits come back ----------
  reset(); balance = 100;
  store.c = draft('c');
  aiFails = true;
  r = await beautifyDraftDescription('u1', 'c', normalizeTemplate());
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(refunded, [2]);
  assert.strictEqual(balance, 100);
  assert.ok(!saved.c, 'nothing is saved on failure');
  aiFails = false;

  // ---------- out of credits ----------
  reset(); balance = 1;
  store.d = draft('d');
  r = await beautifyDraftDescription('u1', 'd', normalizeTemplate());
  assert.strictEqual(r.status, 'no_credits');
  assert.strictEqual(balance, 1, 'nothing is taken when there is not enough');

  // ---------- beautifyManyDraftDescriptions: the balance runs out half way ----------
  ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 2;
  reset(); balance = 4;
  const ids = [];
  for (let i = 0; i < 5; i++) { store['m' + i] = draft('m' + i); ids.push('m' + i); }
  const results = await beautifyManyDraftDescriptions('u1', ids, normalizeTemplate(), { concurrency: 1 });
  assert.strictEqual(results.filter((x) => x.status === 'done').length, 2);
  assert.strictEqual(results.filter((x) => x.status === 'no_credits').length, 3);
  assert.strictEqual(balance, 0);

  // ---------- routes/listings.js: POST /bulk-description-beautify + GET its cost ----------
  reset(); balance = 1000; aiEnabled = true; ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 2;
  for (const id of ['r1', 'r2', 'r3']) store[id] = draft(id);
  let res = await call(listingsRouter, 'post', '/bulk-description-beautify', { ids: ['r1', 'r2', 'r3', 'r1'] });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.results.length, 3, 'a draft listed twice is done once');
  assert.strictEqual(res.body.filled, 3);
  assert.strictEqual(res.body.creditsUsed, 6);
  assert.strictEqual(res.body.cost, 2);
  res = await call(listingsRouter, 'post', '/bulk-description-beautify', { ids: [] });
  assert.strictEqual(res.statusCode, 400);
  res = await call(listingsRouter, 'post', '/bulk-description-beautify', { ids: Array.from({ length: 16 }, (_, i) => 'x' + i) });
  assert.strictEqual(res.statusCode, 400, 'at most 15 per request');
  aiEnabled = false;
  res = await call(listingsRouter, 'post', '/bulk-description-beautify', { ids: ['r1'] });
  assert.strictEqual(res.statusCode, 403);
  aiEnabled = true;
  res = await call(listingsRouter, 'get', '/bulk-description-beautify/cost');
  assert.deepStrictEqual(res.body, { success: true, cost: 2 });

  // ---------- routes/listOnEbay.js: POST /beautify-description (the editor button - never saves by itself) ----------
  reset(); balance = 100; aiEnabled = true; ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 3;
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  res = await call(listOnEbayRouter, 'post', '/beautify-description', { title: 'ab' });
  assert.strictEqual(res.statusCode, 400, 'a title under 3 characters is refused before any AI call');
  res = await call(listOnEbayRouter, 'post', '/beautify-description', { title: 'Acme Shoes', description: 'Black shoes.' });
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.text.includes('Key Features'));
  assert.strictEqual(res.body.creditsUsed, 3);
  assert.ok(!saved.a, 'the single-item route never saves to a listing itself - the editor decides');
  aiEnabled = false;
  res = await call(listOnEbayRouter, 'post', '/beautify-description', { title: 'Acme Shoes' });
  assert.strictEqual(res.statusCode, 403);
  aiEnabled = true;
  balance = 0;
  res = await call(listOnEbayRouter, 'post', '/beautify-description', { title: 'Acme Shoes' });
  assert.strictEqual(res.statusCode, 402);

  // ---------- routes/sellerSettings.js: GET/PUT /description-template ----------
  templates = {};
  res = await call(sellerSettingsRouter, 'get', '/description-template');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.template.templateId, TEMPLATE_STYLES[0].id, 'a seller who never saved one gets the first starter style');
  assert.strictEqual(res.body.styles.length, TEMPLATE_STYLES.length);
  assert.strictEqual(res.body.blocks.length, AVAILABLE_BLOCKS.length);

  res = await call(sellerSettingsRouter, 'put', '/description-template', { templateId: 'premium', blocks: ['bullets', 'specs'], branding: { storeName: 'Acme' } });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.template.templateId, 'premium');
  assert.deepStrictEqual(res.body.template.blocks, ['bullets', 'specs']);
  res = await call(sellerSettingsRouter, 'get', '/description-template');
  assert.strictEqual(res.body.template.templateId, 'premium', 'the saved template is read back on the next GET');

  console.log('description beautify tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
