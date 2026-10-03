// The title and description writers: an AI answer they cannot use (empty / far too short) is FORGOTTEN (answer.discard()), so asking again asks the
// AI again instead of replaying the same empty answer from askClaude's 24 h cache. A usable answer is kept.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let nextText = '';
let discards = 0;
stub('services/aiService', { askClaude: async () => ({ text: nextText, model: 'm', inputTokens: 1, outputTokens: 1, discard: () => { discards += 1; } }) });
stub('models/settingsModel', { getAiSettings: async () => ({ aiCustomInstructions: '' }) });

const { optimizeEbayTitle } = require('../services/titleOptimizerService');
const { generateEbayDescription } = require('../services/descriptionGeneratorService');

(async () => {
  // title
  nextText = '  "  "  '; discards = 0;
  await assert.rejects(() => optimizeEbayTitle({ title: 'Blue Kettle 1.7L' }), /empty title/);
  assert.strictEqual(discards, 1, 'an empty title is forgotten');
  nextText = 'Blue Kettle 1.7L Stainless Steel'; discards = 0;
  const t = await optimizeEbayTitle({ title: 'Blue Kettle 1.7L' });
  assert.strictEqual(t.text, 'Blue Kettle 1.7L Stainless Steel'); assert.strictEqual(discards, 0, 'a usable title is kept');

  // description
  nextText = 'too short'; discards = 0;
  await assert.rejects(() => generateEbayDescription({ title: 'Blue Kettle', bulletPoints: [], specifications: [] }), /empty description/);
  assert.strictEqual(discards, 1, 'an (almost) empty description is forgotten');
  nextText = 'A sturdy blue kettle that boils 1.7 litres of water quickly and switches off by itself.'; discards = 0;
  const d = await generateEbayDescription({ title: 'Blue Kettle', bulletPoints: [], specifications: [] });
  assert.ok(d.text.startsWith('A sturdy blue kettle')); assert.strictEqual(discards, 0, 'a usable description is kept');

  // the buyer-message reply writer
  const { writeReply } = require('../services/replyAssistantService');
  const convo = { messages: [{ isSelf: false, content: 'Does this come in blue?' }], subject: 'Question', storeName: 'Shop', listingTitle: 'Blue Kettle' };
  nextText = ' "" '; discards = 0;
  await assert.rejects(() => writeReply(convo), /empty reply/);
  assert.strictEqual(discards, 1, 'an empty reply is forgotten');
  nextText = 'Hello! Yes, this kettle is blue. Thanks for asking.'; discards = 0;
  assert.match((await writeReply(convo)).text, /^Hello!/); assert.strictEqual(discards, 0, 'a usable reply is kept');

  // an answer without discard() (older stand-ins) is still just rejected
  stub('services/aiService', { askClaude: async () => ({ text: '', model: 'm', inputTokens: 1, outputTokens: 1 }) });
  for (const k of Object.keys(require.cache)) if (/titleOptimizerService/.test(k)) delete require.cache[k];
  const again = require('../services/titleOptimizerService');
  await assert.rejects(() => again.optimizeEbayTitle({ title: 'x' }), /empty title/);

  console.log('ai discard unusable tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
