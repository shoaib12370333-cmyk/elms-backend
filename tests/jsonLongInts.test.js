// services/jsonLongInts.js + the AliExpress gateway call: ids of 16-17 digits (AliExpress's own sample sku_id is 12000027158136202) are
// exact only as STRINGS - as plain JSON numbers they lose their last digits, which for an order number means paying, reading or
// tracking ANOTHER order. Long integers are quoted before parsing; text inside strings is never touched.
const assert = require('assert');
const { quoteLongIntegers, parseJsonKeepingLongIds } = require('../services/jsonLongInts');

// ---------- the problem itself ----------
assert.notStrictEqual(String(JSON.parse('[12000027158136203]')[0]), '12000027158136203', 'plain JSON.parse cannot hold this number');
assert.strictEqual(String(JSON.parse('[12000027158136203]')[0]), '12000027158136204', '...it reads it as the NEXT number: another order');

// ---------- long integers come through exactly, as strings ----------
const raw = '{"order_list":[8123456789012345,12000027158136203,12],"n":1.5,"e":1e20,"neg":-9007199254740993,"nested":{"id":12345678901234567890},"flag":true,"nothing":null,"s":"12000027158136203"}';
const parsed = parseJsonKeepingLongIds(raw);
assert.deepStrictEqual(parsed.order_list, ['8123456789012345', '12000027158136203', 12], 'only the long ones become strings; a short number stays a number');
assert.strictEqual(parsed.neg, '-9007199254740993');
assert.strictEqual(parsed.nested.id, '12345678901234567890');
assert.deepStrictEqual([parsed.n, parsed.e, parsed.flag, parsed.nothing, parsed.s], [1.5, 1e20, true, null, '12000027158136203'], 'fractions, exponents, booleans, null and existing strings are untouched');

// ---------- text inside strings is never rewritten (a long run of digits in a title stays text) ----------
const tricky = '{"title":"call 1234567890123456, now \\" 99999999999999999 and 1234567890123456","id":1234567890123456,"list":["a, 1234567890123456, b"]}';
const t = parseJsonKeepingLongIds(tricky);
assert.strictEqual(t.title, 'call 1234567890123456, now " 99999999999999999 and 1234567890123456');
assert.strictEqual(t.id, '1234567890123456');
assert.deepStrictEqual(t.list, ['a, 1234567890123456, b']);

// ---------- the boundary: 15 digits stay numbers, 16 become strings ----------
assert.deepStrictEqual(parseJsonKeepingLongIds('[123456789012345,1234567890123456]'), [123456789012345, '1234567890123456']);
assert.deepStrictEqual(parseJsonKeepingLongIds('[1234567890,12345]', 10), ['1234567890', 12345], 'the limit can be changed');

// ---------- odd but valid JSON, and invalid JSON ----------
for (const text of ['[]', '{}', '0', '-0', 'true', 'null', '"str"', '[1,2,3]', '{"a":[{"b":[1.0,-2,3e5]}]}', ' \n[ 1 , 2 ] ']) assert.deepStrictEqual(parseJsonKeepingLongIds(text), JSON.parse(text), text);
assert.strictEqual(quoteLongIntegers('[1234567890123456]'), '["1234567890123456"]');
assert.throws(() => parseJsonKeepingLongIds('{not json'), SyntaxError);
assert.throws(() => parseJsonKeepingLongIds(''), SyntaxError);
// a big real-looking answer is quick (linear)
const big = JSON.stringify({ items: Array.from({ length: 20000 }, (_, i) => ({ id: 1000000000000000 + i, name: 'item ' + i, price: '3.94' })) });
const started = Date.now();
const bigParsed = parseJsonKeepingLongIds(big);
assert.strictEqual(bigParsed.items[19999].id, '1000000000019999');
assert.ok(Date.now() - started < 1500, 'linear: ' + (Date.now() - started) + 'ms');

// ---------- the gateway call uses it ----------
process.env.ALIEXPRESS_APP_KEY = 'k';
process.env.ALIEXPRESS_APP_SECRET = 's';
const axiosPath = require.resolve('axios');
let rawAnswer = '{"result":{"is_success":"true","order_list":[12000027158136203]},"code":"0"}';
const configs = [];
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body, config) => { configs.push(config); return { status: 200, data: config.transformResponse[0](rawAnswer) }; } } };
const auth = require('../services/aliexpressAuthService');

(async () => {
  const result = await auth.callBusinessApi('aliexpress.ds.order.create', 'AT', {});
  assert.deepStrictEqual(result.order_list, ['12000027158136203'], 'an order number from the gateway arrives exactly');
  assert.strictEqual(configs[0].transformResponse.length, 1);
  rawAnswer = 'this is not json';
  await assert.rejects(() => auth.callBusinessApi('aliexpress.ds.order.create', 'AT', {}), /something unexpected/, 'a non-JSON answer is still rejected as before');
  rawAnswer = '{"code":"15","rsp_msg":"Remote service error"}';
  await assert.rejects(() => auth.callBusinessApi('aliexpress.ds.order.create', 'AT', {}), (err) => err.aliCode === '15');
  console.log('json long ints tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
