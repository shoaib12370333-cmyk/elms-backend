// Settings -> VeRO: the user's own words. Enter adds a word, chips remove it, suggestions come from the starter list
// but are never flagged unless saved.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const store = { u1: { veroWords: [] }, u2: { veroWords: ['gucci'] } };
stub('models/schemas/User', {
  findById: (id) => ({ lean: async () => (store[id] ? { veroWords: store[id].veroWords.slice() } : null) }),
  updateOne: async ({ _id }, u) => {
    const s = store[_id];
    if (u.$addToSet) for (const w of u.$addToSet.veroWords.$each) if (!s.veroWords.includes(w)) s.veroWords.push(w);
    if (u.$pull) s.veroWords = s.veroWords.filter((w) => w !== u.$pull.veroWords);
    if (u.$set) s.veroWords = u.$set.veroWords;
  },
});
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const svc = require('../services/veroSettingsService');
const router = require('../routes/veroSettings');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, req) => { const res = fakeRes(); await handler(method, p)({ userId: 'u1', body: {}, ...req }, res); return res; };

(async () => {
  // a new user has no words: nothing is flagged until they add some
  let res = await call('get', '/');
  assert.deepStrictEqual(res.body.words, []);
  assert.ok(res.body.suggestions.includes('nike') && res.body.suggestions.length > 300, 'the starter list is offered as suggestions');
  assert.strictEqual(res.body.max, 500);

  // Enter adds one word (lowercased, tidy), a duplicate is ignored
  res = await call('post', '/words', { body: { word: '  Nike ' } });
  assert.deepStrictEqual(res.body.added, ['nike']);
  res = await call('post', '/words', { body: { word: 'NIKE' } });
  assert.deepStrictEqual(res.body.added, []);
  assert.deepStrictEqual(res.body.words, ['nike']);

  // several at once (paste): commas / new lines separate them; unusable pieces are reported
  res = await call('post', '/words', { body: { word: 'Adidas, Air Max' + String.fromCharCode(10) + 'Tiffany & Co, x, ' } });
  assert.deepStrictEqual(res.body.added, ['adidas', 'air max', 'tiffany & co']);
  assert.deepStrictEqual(res.body.skipped, ['x']);
  assert.deepStrictEqual(res.body.words, ['nike', 'adidas', 'air max', 'tiffany & co']);

  // an empty entry is refused
  res = await call('post', '/words', { body: { word: '   ' } });
  assert.strictEqual(res.statusCode, 400);

  // lists are per user
  assert.deepStrictEqual(await svc.getVeroWordsOf('u2'), ['gucci']);

  // remove one, then clear
  res = await call('post', '/words/remove', { body: { word: 'Air Max' } });
  assert.deepStrictEqual(res.body.words, ['nike', 'adidas', 'tiffany & co']);
  res = await call('post', '/words/remove', { body: { word: '' } });
  assert.strictEqual(res.statusCode, 404);
  res = await call('post', '/words/clear');
  assert.deepStrictEqual(res.body.words, []);
  assert.deepStrictEqual(await svc.getVeroWordsOf('u2'), ['gucci'], 'another user is untouched');

  // the limit
  store.u1.veroWords = Array.from({ length: 499 }, (_, i) => 'word' + i);
  res = await call('post', '/words', { body: { word: 'one more' } });
  assert.strictEqual(res.body.success, true);
  res = await call('post', '/words', { body: { word: 'over the limit' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /up to 500/);
  console.log('vero settings tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
