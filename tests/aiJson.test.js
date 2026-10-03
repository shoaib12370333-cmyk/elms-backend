// services/aiJson.js askForJsonObject: asks the AI for a JSON object. An answer that cannot be read is forgotten (askClaude's 24 h cache would otherwise
// replay it to every "try again"), logged, and the AI is asked once more; only when every try is unreadable does it throw.
const assert = require('assert');
const { askForJsonObject, readJsonObject } = require('../services/aiJson');

const warns = [];
console.warn = (...a) => warns.push(a.join(' '));

// a stand-in askClaude: hands out the scripted answers, each with a discard() that is counted
let script = []; let asks = 0; let discards = 0;
const ask = async () => { asks += 1; const text = script.shift(); return { text, model: 'm', inputTokens: 10, outputTokens: 4, discard: () => { discards += 1; } }; };
const reset = (answers) => { script = answers.slice(); asks = 0; discards = 0; warns.length = 0; };

(async () => {
  // the JSON object inside prose is read; things that are not an object are not
  assert.deepStrictEqual(readJsonObject('Sure: {"a":1} thanks'), { a: 1 });
  assert.deepStrictEqual(readJsonObject('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  // a stray } after the object, braces and quotes inside strings, raw line breaks / tabs inside strings, a code fence: all read
  assert.deepStrictEqual(readJsonObject('{"a":1} (I removed Nike})'), { a: 1 }, 'a stray } in the prose after the object');
  assert.deepStrictEqual(readJsonObject('{"t":"a } b \\" { c"} trailing }'), { t: 'a } b " { c' }, 'braces and an escaped quote inside a string do not count');
  assert.deepStrictEqual(readJsonObject('{"t":"line one\nline two\tend\r\n"}'), { t: 'line one\nline two\tend\r\n' }, 'a raw line break / tab inside a string');
  assert.deepStrictEqual(readJsonObject('{"t":"a\u0001b"} done }'), { t: 'a\u0001b' }, 'another control character');
  assert.deepStrictEqual(readJsonObject('```json\n{"a":[1,{"b":2}]}\n```'), { a: [1, { b: 2 }] }, 'a code fence');
  assert.deepStrictEqual(readJsonObject('{"a":{"b":"x\\\\"}} }'), { a: { b: 'x\\' } }, 'a backslash at the end of a string');
  // two objects: no guessing which is the answer
  assert.strictEqual(readJsonObject('{"a":1} and then {"b":2}'), null);
  assert.strictEqual(readJsonObject('{"a":1 and a stray } and {"b":2}'), null);
  for (const bad of ['', null, undefined, 'no braces', '{"a":', '{"a":1', 'a } b { c', '[1,2]', '{broken json}', 'text {"title":"cut off']) assert.strictEqual(readJsonObject(bad), null, JSON.stringify(bad));

  // readable the first time: one ask, nothing forgotten
  reset(['{"title":"x"}']);
  let r = await askForJsonObject(ask, { prompt: 'p' }, { label: 'test' });
  assert.deepStrictEqual(r.parsed, { title: 'x' });
  assert.deepStrictEqual([asks, discards, warns.length], [1, 0, 0]);
  assert.deepStrictEqual(r.usage, { text: '{"title":"x"}', model: 'm', inputTokens: 10, outputTokens: 4 });

  // unreadable, then readable: the bad one is forgotten and logged, the AI is asked again, both are counted
  reset(['{"title":"Running sho', 'Here: {"title":"y"} done']);
  r = await askForJsonObject(ask, { prompt: 'p' }, { label: 'test' });
  assert.deepStrictEqual(r.parsed, { title: 'y' });
  assert.deepStrictEqual([asks, discards], [2, 1]);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /^\[test\] the AI answer could not be read \(try 1\/2\), 21 characters: "\{\\"title\\":\\"Running sho" \.\.\. "\{\\"title\\":\\"Running sho"$/, 'the log names the feature, the try, the length, the start and the end');
  assert.deepStrictEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.text], [20, 8, 'Here: {"title":"y"} done'], 'usage adds up every try; text is the last answer');

  // unreadable every time: both forgotten, then the message the screens show
  reset(['nope', '[1,2]']);
  await assert.rejects(() => askForJsonObject(ask, { prompt: 'p' }), (e) => { assert.strictEqual(e.statusCode, 502); assert.strictEqual(e.message, 'The AI answer could not be read. Please try again.'); return true; });
  assert.deepStrictEqual([asks, discards, warns.length], [2, 2, 2]);
  assert.match(warns[0], /^\[ai\] /, 'default label');

  // the number of tries is a setting; an AI that throws (down, busy) is not caught here
  reset(['x', 'y', '{"z":1}']);
  r = await askForJsonObject(ask, { prompt: 'p' }, { attempts: 3 });
  assert.deepStrictEqual([r.parsed, asks, discards], [{ z: 1 }, 3, 2]);
  await assert.rejects(() => askForJsonObject(async () => { throw Object.assign(new Error('AI is down'), { statusCode: 502 }); }, { prompt: 'p' }), /AI is down/);

  // an answer without discard() (a stand-in, or older code) is fine; a very long unreadable answer logs only its two ends
  reset([]);
  const long = '{' + 'a'.repeat(5000);
  await assert.rejects(() => askForJsonObject(async () => ({ text: long, model: 'm' }), { prompt: 'p' }), /could not be read/);
  assert.ok(warns.length === 2 && warns[0].length < 500, 'the log line stays short: ' + warns[0].length);
  assert.match(warns[0], /5001 characters/);

  console.log('ai json tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
