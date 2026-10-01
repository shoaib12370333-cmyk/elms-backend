// services/aiService.js askClaude: one call to the Anthropic Messages API using the admin's chosen model, with every
// answer cached (services/aiResponseCache.js) - an identical {system, prompt, maxTokens, model} within the TTL is
// answered without a second network call (and reports 0 input/output tokens, since none were actually spent).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let aiModel = 'claude-haiku-test';
stub('models/settingsModel', { getAiSettings: async () => ({ aiModel }) });

const postCalls = [];
let nextResponse = () => ({ data: { content: [{ text: 'hello' }], usage: { input_tokens: 10, output_tokens: 5 } } });
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { post: async (url, body, opts) => { postCalls.push({ url, body, opts }); return nextResponse(); } },
};

const origKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key';
const { askClaude, aiConfigured, _responseCache } = require('../services/aiService');

(async () => {
  // ---------- no API key: a clear 503, never even tries to call out, and does not touch the cache ----------
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => askClaude({ prompt: 'x' }), (err) => { assert.strictEqual(err.statusCode, 503); return true; });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  assert.strictEqual(aiConfigured(), true);

  // ---------- a normal call: posts to Anthropic with the admin's chosen model, returns the real token counts ----------
  postCalls.length = 0;
  let r = await askClaude({ prompt: 'Describe a kettle', system: 'You are helpful.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 1);
  assert.strictEqual(postCalls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(postCalls[0].body.model, 'claude-haiku-test');
  assert.strictEqual(postCalls[0].body.system, 'You are helpful.');
  assert.strictEqual(postCalls[0].body.messages[0].content, 'Describe a kettle');
  assert.deepStrictEqual(r, { text: 'hello', model: 'claude-haiku-test', inputTokens: 10, outputTokens: 5 });

  // ---------- the EXACT same call again: answered from cache - no second network call, 0 tokens reported ----------
  postCalls.length = 0;
  r = await askClaude({ prompt: 'Describe a kettle', system: 'You are helpful.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 0, 'never asked Claude again for the same question');
  assert.deepStrictEqual(r, { text: 'hello', model: 'claude-haiku-test', inputTokens: 0, outputTokens: 0 });

  // ---------- a different prompt: a cache miss, asks again ----------
  postCalls.length = 0;
  nextResponse = () => ({ data: { content: [{ text: 'a toaster' }], usage: { input_tokens: 8, output_tokens: 4 } } });
  r = await askClaude({ prompt: 'Describe a toaster', system: 'You are helpful.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 1);
  assert.strictEqual(r.text, 'a toaster');

  // ---------- a different maxTokens, or a different system, or no system at all: each is its own cache key ----------
  postCalls.length = 0;
  nextResponse = () => ({ data: { content: [{ text: 'hello-2' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  await askClaude({ prompt: 'Describe a kettle', system: 'You are helpful.', maxTokens: 99 });
  assert.strictEqual(postCalls.length, 1, 'different maxTokens: not the same cache entry');
  postCalls.length = 0;
  await askClaude({ prompt: 'Describe a kettle', system: 'A different system prompt.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 1, 'different system: not the same cache entry');
  postCalls.length = 0;
  await askClaude({ prompt: 'Describe a kettle', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 1, 'no system at all: still its own cache entry, distinct from one with a system');

  // ---------- the admin changes the AI model: even the exact same prompt is a cache miss (a different model can answer differently) ----------
  postCalls.length = 0;
  aiModel = 'claude-opus-test';
  nextResponse = () => ({ data: { content: [{ text: 'hello-opus' }], usage: { input_tokens: 20, output_tokens: 9 } } });
  r = await askClaude({ prompt: 'Describe a kettle', system: 'You are helpful.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 1);
  assert.strictEqual(r.model, 'claude-opus-test');
  aiModel = 'claude-haiku-test'; // back to the model used above, so the ORIGINAL cache entry (from the first call) still answers it
  postCalls.length = 0;
  r = await askClaude({ prompt: 'Describe a kettle', system: 'You are helpful.', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 0, 'the haiku-model cache entry from earlier is untouched by the opus call in between');
  assert.strictEqual(r.text, 'hello');

  // ---------- a failed call is never cached: the next identical call tries again, not a cached failure (there's no such thing) ----------
  postCalls.length = 0;
  nextResponse = () => { throw Object.assign(new Error('rejected'), { response: { data: { error: { message: 'eBay style failure' } } } }); };
  await assert.rejects(() => askClaude({ prompt: 'Describe a blender', maxTokens: 50 }), (err) => { assert.strictEqual(err.statusCode, 502); assert.match(err.message, /eBay style failure/); return true; });
  assert.strictEqual(postCalls.length, 1);
  nextResponse = () => ({ data: { content: [{ text: 'a blender' }], usage: { input_tokens: 3, output_tokens: 2 } } });
  r = await askClaude({ prompt: 'Describe a blender', maxTokens: 50 });
  assert.strictEqual(postCalls.length, 2, 'tried again for real - the earlier failure left nothing in the cache');
  assert.strictEqual(r.text, 'a blender');

  assert.ok(_responseCache.size > 0, 'the cache actually holds entries by now');

  process.env.ANTHROPIC_API_KEY = origKey;
  console.log('ai service tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
