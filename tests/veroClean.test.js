// The AI cleaner: uses the AI's rewrite, then guarantees none of the user's words is left; brand / specifics are cleaned by rule.
const assert = require('assert');
const aiPath = require.resolve('../services/aiService');
require(aiPath);
let answer = '';
let prompts = [];
require.cache[aiPath].exports.askClaude = async ({ prompt }) => { prompts.push(prompt); return { text: answer, model: 't', inputTokens: 1, outputTokens: 1 }; };
const { cleanVeroTerms } = require('../services/veroCleanerService');
const { createMatcher } = require('../services/veroService');

const words = ['nike', 'air max', 'marvel', 'apple', 'adidas'];
const remaining = (data) => createMatcher(words).scanListing(data).terms;

(async () => {
  const input = {
    title: 'Nike Air Max running shoes for men', description: 'Soft shoes by Nike.' + String.fromCharCode(10) + 'Marvel fans love them.',
    bulletPoints: ['Nike quality', 'Comfortable'], specifications: [{ name: 'Brand', value: 'Nike' }, { name: 'Color', value: 'Black' }],
    aspects: { Brand: ['Nike'], Color: ['Black'] }, brand: 'Nike',
  };
  // the AI removes most words but leaves "Marvel" behind -> the sweep removes it
  answer = 'Sure: ' + JSON.stringify({ title: 'Running shoes for men', description: 'Soft shoes.' + String.fromCharCode(10) + 'Marvel fans love them.', bulletPoints: ['Great quality', 'Comfortable'] });
  let out = await cleanVeroTerms(input, words);
  assert.strictEqual(out.data.title, 'Running shoes for men');
  assert.strictEqual(out.data.description, 'Soft shoes.' + String.fromCharCode(10) + 'fans love them.');
  assert.deepStrictEqual(out.data.bulletPoints, ['Great quality', 'Comfortable']);
  assert.deepStrictEqual(out.data.specifications, [{ name: 'Brand', value: 'Unbranded' }, { name: 'Color', value: 'Black' }]);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'], Color: ['Black'] });
  assert.ok(['nike', 'air max', 'marvel'].every((w) => out.data.removed.includes(w)));
  assert.deepStrictEqual(remaining(out.data), [], 'the result contains none of the user\'s words');
  assert.match(prompts[0], /nike, air max/);

  // a word the user did NOT save is left alone
  answer = JSON.stringify({ title: 'Gucci belt' });
  out = await cleanVeroTerms({ title: 'Gucci belt by Nike', description: '', bulletPoints: [], specifications: [], aspects: {}, brand: '' }, words);
  assert.strictEqual(out.data.title, 'Gucci belt');

  // a wrong number of bullets from the AI is ignored (rule-based cleaning of the originals is used)
  answer = '{"title":"Shoes","bulletPoints":["only one"]}';
  out = await cleanVeroTerms(input, words);
  assert.deepStrictEqual(out.data.bulletPoints, ['quality', 'Comfortable']);
  assert.deepStrictEqual(remaining(out.data), []);

  // a very long title from the AI is cut to 80
  answer = JSON.stringify({ title: 'Shoes '.repeat(30) });
  out = await cleanVeroTerms(input, words);
  assert.ok(out.data.title.length <= 80);

  // unreadable answer -> error (the route refunds the credit)
  answer = 'no json here';
  await assert.rejects(() => cleanVeroTerms(input, words), /could not be read/);

  // nothing in the running text: no AI call at all, the rule-based part still runs
  prompts = [];
  out = await cleanVeroTerms({ title: 'Plain table', description: 'A table.', bulletPoints: [], specifications: [], aspects: { Brand: ['Adidas'] }, brand: '' }, words);
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'] });

  // no saved words at all: nothing to remove
  prompts = [];
  out = await cleanVeroTerms({ title: 'Nike shoes', description: '', bulletPoints: [], specifications: [], aspects: {}, brand: '' }, []);
  assert.strictEqual(prompts.length, 0);
  assert.strictEqual(out.data.title, 'Nike shoes');
  console.log('vero clean tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
