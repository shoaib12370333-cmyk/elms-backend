const assert = require('assert');
const Module = require('module');

// Mock the Anthropic call so the parsing / validation rules can be tested offline.
const aiPath = require.resolve('../services/aiService');
require(aiPath);
let nextAnswer = '';
require.cache[aiPath].exports.askClaude = async () => ({ text: nextAnswer, model: 'test', inputTokens: 1, outputTokens: 1 });

(async () => {
  const { fillItemSpecifics } = require('../services/aspectFillerService');
  const aspects = [
    { name: 'Brand', required: true, values: [] },
    { name: 'Colour', required: false, usage: 'RECOMMENDED', values: ['Black', 'Blue'] },
    { name: 'Features', required: false, cardinality: 'MULTI', values: ['Waterproof', 'Foldable'] },
    { name: 'Type', required: false, values: ['A', 'B'] },
  ];
  nextAnswer = 'Here you go: {"brand":"Acme","Colour":"black","Features":["waterproof","Invisible","Foldable"],"Type":"Z","Unknown":"x"} thanks';
  const out = await fillItemSpecifics({ title: 'Acme bag', aspects, existing: {} });
  assert.deepStrictEqual(out.data.values, { Brand: ['Acme'], Colour: ['Black'], Features: ['Waterproof', 'Foldable'] });

  nextAnswer = '{"Brand":"Other","Colour":"Blue"}';
  const kept = await fillItemSpecifics({ title: 'Acme bag', aspects, existing: { Brand: ['Mine'] } });
  assert.deepStrictEqual(kept.data.values, { Colour: ['Blue'] }); // never overwrites what the seller typed

  nextAnswer = 'not json';
  await assert.rejects(() => fillItemSpecifics({ title: 'x', aspects }), /could not be read/);

  const { SENSITIVE } = require('../services/replyAssistantService');
  assert.ok(SENSITIVE.test('I want a refund, item arrived damaged'));
  assert.ok(!SENSITIVE.test('Hi, does this come in blue? Thanks'));
  console.log('ai feature tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
