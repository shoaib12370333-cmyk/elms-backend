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
  assert.deepStrictEqual(out.missingBlocks, [], 'every instructed block was found in the AI\'s answer - nothing flagged');
  assert.deepStrictEqual(out.warnings, []);

  // a data block with nothing behind it is removed cleanly, not left as an empty gap or a literal token
  aiAnswer = '<p>Facts</p>{{ELMS_GALLERY}}{{ELMS_VIDEO}}';
  out = await beautifyEbayDescription({ title: 'X', images: [], template: { templateId: 'minimal', blocks: ['gallery', 'video'], branding: {}, videoUrl: '' } });
  assert.strictEqual(out.text, '<p>Facts</p>', 'no images and no video URL: both placeholders vanish, nothing invented');

  // silent-failure guard 1: the AI simply omits an instructed 'ai' block (drops the "Shipping & Delivery" section
  // entirely instead of writing it) - must not throw, but must be reported instead of just shipping a shorter
  // description than the seller's template configured with nothing surfaced anywhere.
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'],
    template: { templateId: 'minimal', blocks: ['bullets', 'shipping'], branding: {} },
  });
  assert.ok(out.text.includes('Key Features'), 'the description is still returned, not blocked by a missing block');
  assert.deepStrictEqual(out.missingBlocks, ['shipping'], 'the AI silently dropped the shipping section - flagged, not swallowed');
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /Shipping & Delivery/);

  // silent-failure guard 2: the AI paraphrases or drops the literal data-block placeholder token instead of
  // echoing it back verbatim - split/join then finds nothing to splice, so the gallery must be flagged too, not
  // just silently absent from the final HTML.
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul><p>See the photos above.</p>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'], images: ['https://a.com/1.jpg'],
    template: { templateId: 'minimal', blocks: ['bullets', 'gallery'], branding: {} },
  });
  assert.deepStrictEqual(out.missingBlocks, ['gallery'], 'the AI paraphrased away the {{ELMS_GALLERY}} token - flagged, not swallowed');
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /Image Gallery/);
  assert.ok(!out.text.includes('https://a.com/1.jpg'), 'with no placeholder to splice into, the real image is correctly never appended blindly');

  // an empty/too-short AI answer is a hard failure, never saved as a real description
  aiAnswer = 'hi';
  await assert.rejects(() => beautifyEbayDescription({ title: 'X', template: {} }), /empty description/);

  // silent-failure guard 3: a bare, common word from another block's heading (shipping, returns) showing up by
  // coincidence in a DIFFERENT section's own prose - here, the FAQ answers - must never be mistaken for that
  // block's own heading. The real "Shipping & Delivery" / "Returns & Warranty" sections were never written at all.
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul><h2>FAQ</h2><p>Q: How long does shipping take? A: It varies.</p><p>Q: What is your returns process? A: Contact us.</p>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'],
    template: { templateId: 'minimal', blocks: ['bullets', 'shipping', 'returns', 'faq'], branding: {} },
  });
  assert.deepStrictEqual(out.missingBlocks, ['shipping', 'returns'], 'the bare words inside the FAQ answers are not the real Shipping & Delivery / Returns & Warranty sections, which the AI never wrote');
  assert.strictEqual(out.warnings.length, 2);

  // silent-failure guard 4: a <ul><li> list belongs to whichever heading it actually sits under - a FAQ formatted
  // as a bullet list is not the Key Features block the AI dropped, even though a <li> exists somewhere in the answer.
  aiAnswer = '<h2>FAQ</h2><ul><li>Q: Is this waterproof? A: Yes.</li><li>Q: What size? A: One size.</li></ul>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'],
    template: { templateId: 'minimal', blocks: ['bullets', 'faq'], branding: {} },
  });
  assert.deepStrictEqual(out.missingBlocks, ['bullets'], 'the FAQ\'s own bullet list is not the Key Features bullets - those were never written');

  // a genuine bullets list written first, with no heading text at all, is still accepted (nothing else claims it)
  aiAnswer = '<ul><li>Black mesh</li><li>Lightweight</li></ul>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', bulletPoints: ['Black mesh'],
    template: { templateId: 'minimal', blocks: ['bullets'], branding: {} },
  });
  assert.deepStrictEqual(out.missingBlocks, [], 'a real bullet list with no other section claiming it is still recognized, heading text or not');

  // a genuine specs table right after its own heading is recognized even without the bare word "specifications"
  // appearing anywhere else, and a table that actually belongs to a different section is not mistaken for it
  aiAnswer = '<h2>Specifications</h2><table><tr><td>Color</td><td>Black</td></tr></table><h2>Returns &amp; Warranty</h2><table><tr><td>Window</td><td>30 days</td></tr></table>';
  out = await beautifyEbayDescription({
    title: 'Acme Shoes', specifications: [{ name: 'Color', value: 'Black' }],
    template: { templateId: 'minimal', blocks: ['specs', 'returns'], branding: {} },
  });
  assert.deepStrictEqual(out.missingBlocks, [], 'the specs table under its own heading, and the returns table under its own heading, are each correctly attributed');

  // 'intro' has no heading of its own (it is the sales pitch a shopper reads first, the prompt tells the AI not to
  // title it) - it is checked by whether there is a real paragraph of text before the next block's own heading.
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  out = await beautifyEbayDescription({ title: 'Acme Shoes', bulletPoints: ['Black mesh'], template: { templateId: 'minimal', blocks: ['intro', 'bullets'], branding: {} } });
  assert.deepStrictEqual(out.missingBlocks, ['intro'], 'the AI jumped straight to Key Features - the sales-pitch paragraph it was told to write first was never there');

  aiAnswer = '<p>This shoe combines comfort and durability for everyday runners who want reliable support.</p><h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  out = await beautifyEbayDescription({ title: 'Acme Shoes', bulletPoints: ['Black mesh'], template: { templateId: 'minimal', blocks: ['intro', 'bullets'], branding: {} } });
  assert.deepStrictEqual(out.missingBlocks, [], 'a real sales-pitch paragraph before Key Features is recognized even with no heading of its own');

  // 'trust_badges' has no heading either, and no fixed wording - presence also asks for a plausible reassurance
  // word, so an unrelated sentence in its slot is not mistaken for it.
  aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  out = await beautifyEbayDescription({ title: 'Acme Shoes', bulletPoints: ['Black mesh'], template: { templateId: 'bold', blocks: ['trust_badges', 'bullets'], branding: {} } });
  assert.deepStrictEqual(out.missingBlocks, ['trust_badges'], 'the AI never wrote a reassurance line at all');

  aiAnswer = '<p>Buyer Protection included with every secure checkout.</p><h2>Key Features</h2><ul><li>Black mesh</li></ul>';
  out = await beautifyEbayDescription({ title: 'Acme Shoes', bulletPoints: ['Black mesh'], template: { templateId: 'bold', blocks: ['trust_badges', 'bullets'], branding: {} } });
  assert.deepStrictEqual(out.missingBlocks, [], 'a real reassurance line before Key Features is recognized');

  // specs written as a <ul> under a heading this heuristic doesn't recognize ("Product Details" instead of
  // "Specifications") is still real content, not a dropped block - a <ul>/<li> list is accepted for specs too,
  // same as the <table> the prompt actually asked for.
  aiAnswer = '<h2>Product Details</h2><ul><li>Color: Black</li><li>Weight: 1kg</li></ul>';
  out = await beautifyEbayDescription({ title: 'Acme Shoes', specifications: [{ name: 'Color', value: 'Black' }], template: { templateId: 'minimal', blocks: ['specs'], branding: {} } });
  assert.deepStrictEqual(out.missingBlocks, [], 'real specs under an unrecognized heading are still recognized by their own list markup');

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
  assert.deepStrictEqual(res.body.results[0].missingBlocks, ['intro', 'shipping'], 'the seller\'s default template also asks for a sales-pitch intro and Shipping & Delivery, neither of which the AI answer wrote - the flags must reach the HTTP response, not just the service\'s own return value');
  assert.strictEqual(res.body.results[0].warnings.length, 2);
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
  assert.deepStrictEqual(res.body.missingBlocks, ['intro', 'shipping'], 'missingBlocks/warnings must reach this route\'s own HTTP response too, not just the service function');
  assert.strictEqual(res.body.warnings.length, 2);
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
