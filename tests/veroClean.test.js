// The AI cleaner: uses the AI's rewrite, then guarantees nothing listed is left; brand / specifics are cleaned by rule.
const assert = require('assert');
const aiPath = require.resolve('../services/aiService');
require(aiPath);
let answer = '';
let prompts = [];
require.cache[aiPath].exports.askClaude = async ({ prompt }) => { prompts.push(prompt); return { text: answer, model: 't', inputTokens: 1, outputTokens: 1 }; };
const { cleanVeroTerms } = require('../services/veroCleanerService');
const { scanListing } = require('../services/veroService');

(async () => {
  const input = {
    title: 'Nike Air Max running shoes for men', description: 'Soft shoes by Nike.\nMarvel fans love them.',
    bulletPoints: ['Nike quality', 'Comfortable'], specifications: [{ name: 'Brand', value: 'Nike' }, { name: 'Color', value: 'Black' }],
    aspects: { Brand: ['Nike'], Color: ['Black'] }, brand: 'Nike',
  };
  // the AI removes most words but leaves "Marvel" behind -> the sweep removes it
  answer = 'Sure: ' + JSON.stringify({ title: 'Running shoes for men', description: 'Soft shoes.' + String.fromCharCode(10) + 'Marvel fans love them.', bulletPoints: ['Great quality', 'Comfortable'] });
  let out = await cleanVeroTerms(input);
  assert.strictEqual(out.data.title, 'Running shoes for men');
  assert.strictEqual(out.data.description, 'Soft shoes.\nfans love them.');
  assert.deepStrictEqual(out.data.bulletPoints, ['Great quality', 'Comfortable']);
  assert.deepStrictEqual(out.data.specifications, [{ name: 'Brand', value: 'Unbranded' }, { name: 'Color', value: 'Black' }]);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'], Color: ['Black'] });
  assert.ok(['nike', 'air max', 'marvel'].every((w) => out.data.removed.includes(w)));
  assert.deepStrictEqual(scanListing(out.data).terms, [], 'the result contains no listed word');
  assert.match(prompts[0], /nike, air max/);

  // a wrong number of bullets from the AI is ignored (rule-based cleaning of the originals is used)
  answer = '{"title":"Shoes","bulletPoints":["only one"]}';
  out = await cleanVeroTerms(input);
  assert.deepStrictEqual(out.data.bulletPoints, ['quality', 'Comfortable']);
  assert.deepStrictEqual(scanListing(out.data).terms, []);

  // a very long title from the AI is cut to 80
  answer = JSON.stringify({ title: 'Shoes '.repeat(30) });
  out = await cleanVeroTerms(input);
  assert.ok(out.data.title.length <= 80);

  // unreadable answer -> error (the route refunds the credit)
  answer = 'no json here';
  await assert.rejects(() => cleanVeroTerms(input), /could not be read/);

  // nothing in the running text: no AI call at all, the rule-based part still runs
  prompts = [];
  out = await cleanVeroTerms({ title: 'Plain table', description: 'A table.', bulletPoints: [], specifications: [], aspects: { Brand: ['Adidas'] }, brand: '' });
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'] });

  // a word that is also ordinary language ("ring") is left to the AI's judgement and stays where it means a ring
  prompts = [];
  answer = JSON.stringify({ title: 'Diamond Ring gift box' });
  out = await cleanVeroTerms({ title: 'Diamond Ring by Nike gift box', description: '', bulletPoints: [], specifications: [{ name: 'Type', value: 'Ring' }], aspects: { Type: ['Ring'], Brand: ['Apple'] }, brand: '' });
  assert.strictEqual(out.data.title, 'Diamond Ring gift box');
  assert.match(prompts[0], /ALSO ordinary language: ring/);
  assert.deepStrictEqual(out.data.specifications, [{ name: 'Type', value: 'Ring' }], 'a Type value keeps "Ring"');
  assert.deepStrictEqual(out.data.aspects, { Type: ['Ring'], Brand: ['Unbranded'] }, 'but a Brand of Apple becomes Unbranded');
  assert.deepStrictEqual(out.data.removed.sort(), ['apple', 'nike']);
  assert.deepStrictEqual(out.data.kept.sort(), ['ring']);

  // the rule sweep still removes clear-cut words the AI left, but not ordinary-language ones
  answer = JSON.stringify({ title: 'Nike Ring box' });
  out = await cleanVeroTerms({ title: 'Nike Ring box', description: '', bulletPoints: [], specifications: [], aspects: {}, brand: '' });
  assert.strictEqual(out.data.title, 'Ring box');
  console.log('vero clean tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
