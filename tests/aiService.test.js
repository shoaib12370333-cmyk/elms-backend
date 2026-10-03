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
const { askClaude, aiConfigured, deps, _responseCache } = require('../services/aiService');
const waits = [];
deps.sleep = async (ms) => { waits.push(ms); }; // no real waiting in the retry tests
deps.random = () => 0; // and no random extra wait (the jitter has its own test)

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

  // ---------- an answer the caller cannot use can be forgotten: asking again asks Claude again (it used to be replayed for 24 hours) ----------
  postCalls.length = 0;
  nextResponse = () => ({ data: { content: [{ text: 'not json at all' }], usage: { input_tokens: 5, output_tokens: 3 } } });
  r = await askClaude({ prompt: 'Return JSON about a lamp', maxTokens: 60 });
  assert.strictEqual(r.text, 'not json at all'); assert.strictEqual(postCalls.length, 1);
  assert.deepStrictEqual(Object.keys(r), ['text', 'model', 'inputTokens', 'outputTokens'], 'discard is not listed: the answer looks exactly as before');
  assert.strictEqual(typeof r.discard, 'function');
  let again = await askClaude({ prompt: 'Return JSON about a lamp', maxTokens: 60 });
  assert.strictEqual(postCalls.length, 1, 'still cached until the caller says it cannot use it');
  again.discard(); // a cache hit carries discard too
  nextResponse = () => ({ data: { content: [{ text: '{"lamp":true}' }], usage: { input_tokens: 5, output_tokens: 3 } } });
  again = await askClaude({ prompt: 'Return JSON about a lamp', maxTokens: 60 });
  assert.strictEqual(postCalls.length, 2, 'after discard() Claude is asked again');
  assert.strictEqual(again.text, '{"lamp":true}');
  await askClaude({ prompt: 'Return JSON about a lamp', maxTokens: 60 });
  assert.strictEqual(postCalls.length, 2, 'and the good answer is cached');

  // an empty answer is never kept
  postCalls.length = 0;
  nextResponse = () => ({ data: { content: [{ text: '   ' }], usage: { input_tokens: 5, output_tokens: 0 } } });
  await askClaude({ prompt: 'Say something empty', maxTokens: 20 });
  nextResponse = () => ({ data: { content: [{ text: 'now a word' }], usage: { input_tokens: 5, output_tokens: 2 } } });
  r = await askClaude({ prompt: 'Say something empty', maxTokens: 20 });
  assert.strictEqual(postCalls.length, 2, 'an empty answer left nothing in the cache'); assert.strictEqual(r.text, 'now a word');

  // ---------- a busy API (429 / 529 / 500 / 503) is asked again, twice at most, after the wait it names (at most 5 s) ----------
  const busy = (status, headers = {}) => Object.assign(new Error('busy'), { response: { status, headers, data: { error: { message: 'Overloaded' } } } });
  const good = () => ({ data: { content: [{ text: 'fine' }], usage: { input_tokens: 2, output_tokens: 1 } } });
  postCalls.length = 0; waits.length = 0;
  let script = [() => { throw busy(429, { 'retry-after': '2' }); }, good];
  nextResponse = () => script.shift()();
  r = await askClaude({ prompt: 'Busy test one', maxTokens: 20 });
  assert.strictEqual(r.text, 'fine'); assert.strictEqual(postCalls.length, 2); assert.deepStrictEqual(waits, [2000], 'waited as long as Retry-After said');

  postCalls.length = 0; waits.length = 0;
  script = [() => { throw busy(529); }, () => { throw busy(503); }, good];
  r = await askClaude({ prompt: 'Busy test two', maxTokens: 20 });
  assert.strictEqual(r.text, 'fine'); assert.strictEqual(postCalls.length, 3); assert.deepStrictEqual(waits, [1000, 2000], 'no Retry-After: 1 s, then 2 s');

  // asked to wait longer than 5 s: not waited out (it would hold the whole bulk request) - it fails at once, as any refused call does
  postCalls.length = 0; waits.length = 0;
  script = [() => { throw busy(429, { 'retry-after': '60' }); }, good];
  await assert.rejects(() => askClaude({ prompt: 'Busy test three', maxTokens: 20 }), (err) => err.statusCode === 502 && /Overloaded/.test(err.message));
  assert.strictEqual(postCalls.length, 1); assert.deepStrictEqual(waits, [], 'a Retry-After above 5 s is not waited for');

  // up to 25% is added, so 8 parallel calls do not all come back in the same instant - and 5 s is still the most it waits
  postCalls.length = 0; waits.length = 0; deps.random = () => 1;
  script = [() => { throw busy(429, { 'retry-after': '2' }); }, good];
  await askClaude({ prompt: 'Busy test three b', maxTokens: 20 });
  assert.deepStrictEqual(waits, [2500], '2 s + 25%');
  waits.length = 0; script = [() => { throw busy(429, { 'retry-after': '5' }); }, good];
  await askClaude({ prompt: 'Busy test three c', maxTokens: 20 });
  assert.deepStrictEqual(waits, [5000], '5 s + 25% is cut back to 5 s');
  waits.length = 0; script = [() => { throw busy(529); }, () => { throw busy(529); }, good];
  await askClaude({ prompt: 'Busy test three d', maxTokens: 20 });
  assert.deepStrictEqual(waits, [1250, 2500], 'the default 1 s and 2 s get the same extra');
  deps.random = () => 0;

  postCalls.length = 0; waits.length = 0;
  script = [() => { throw busy(500); }, () => { throw busy(500); }, () => { throw busy(500); }, good];
  await assert.rejects(() => askClaude({ prompt: 'Busy test four', maxTokens: 20 }), (err) => { assert.strictEqual(err.statusCode, 502); assert.match(err.message, /Overloaded/); return true; });
  assert.strictEqual(postCalls.length, 3, 'one try and two more, then it gives up');

  postCalls.length = 0; waits.length = 0;
  script = [() => { throw busy(400); }, good];
  await assert.rejects(() => askClaude({ prompt: 'Busy test five', maxTokens: 20 }), (err) => err.statusCode === 502);
  assert.strictEqual(postCalls.length, 1, 'a refused request (400) is not asked again'); assert.deepStrictEqual(waits, []);
  script = [() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }, good];
  postCalls.length = 0;
  await assert.rejects(() => askClaude({ prompt: 'Busy test six', maxTokens: 20 }), (err) => err.statusCode === 502);
  assert.strictEqual(postCalls.length, 1, 'a network error without a status is not asked again (as before)');

  process.env.ANTHROPIC_API_KEY = origKey;
  console.log('ai service tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
