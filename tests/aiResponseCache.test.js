// services/aiResponseCache.js: a size-capped, TTL'd in-memory cache (the same Map + FIFO-eviction shape already used
// by aiCategoryService.js's own cache, factored out so services/aiService.js's askClaude can use it too) plus a
// stable hash of any JSON-able value for building cache keys.
const assert = require('assert');
const { makeCache, hashKey } = require('../services/aiResponseCache');

(async () => {
  // ---------- hashKey: stable regardless of object key order, different for different values ----------
  assert.strictEqual(hashKey({ a: 1, b: 2 }), hashKey({ b: 2, a: 1 }), 'same data, different property order: same hash');
  assert.notStrictEqual(hashKey({ a: 1 }), hashKey({ a: 2 }));
  assert.notStrictEqual(hashKey('x'), hashKey('y'));
  assert.strictEqual(hashKey([{ a: 1, b: 2 }, 'x']), hashKey([{ b: 2, a: 1 }, 'x']), 'nested objects inside arrays are sorted too');
  assert.strictEqual(typeof hashKey({ a: 1 }), 'string');

  // ---------- makeCache: basic get/set round trip, miss on an unknown key ----------
  let cache = makeCache({ ttlMs: 10000, max: 3 });
  assert.strictEqual(cache.get('k1'), undefined, 'nothing cached yet');
  cache.set('k1', { v: 1 });
  assert.deepStrictEqual(cache.get('k1'), { v: 1 });
  assert.strictEqual(cache.size, 1);

  // ---------- TTL: expires after ttlMs, not before ----------
  cache = makeCache({ ttlMs: 30, max: 10 });
  cache.set('k', 'v');
  assert.strictEqual(cache.get('k'), 'v', 'still fresh');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(cache.get('k'), undefined, 'expired after the TTL');
  assert.strictEqual(cache.size, 0, 'an expired read also cleans up the entry');

  // ---------- size cap: FIFO eviction once over max ----------
  cache = makeCache({ ttlMs: 60000, max: 3 });
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.strictEqual(cache.size, 3);
  cache.set('d', 4); // pushes the cache 1 over max -> the oldest (a) is evicted
  assert.strictEqual(cache.size, 3, 'never grows past max');
  assert.strictEqual(cache.get('a'), undefined, 'the oldest entry was evicted');
  assert.strictEqual(cache.get('b'), 2); assert.strictEqual(cache.get('c'), 3); assert.strictEqual(cache.get('d'), 4);

  // ---------- re-setting an existing key refreshes its position (not the next one evicted) ----------
  cache = makeCache({ ttlMs: 60000, max: 3 });
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  cache.set('a', 'updated'); // 'a' is now the most-recently-written, 'b' is the oldest
  cache.set('d', 4); // over max -> 'b' (now the oldest) is evicted, not 'a'
  assert.strictEqual(cache.get('a'), 'updated', 'a survives - it was refreshed');
  assert.strictEqual(cache.get('b'), undefined, 'b is the one evicted, since a was no longer the oldest');
  assert.strictEqual(cache.get('c'), 3); assert.strictEqual(cache.get('d'), 4);

  console.log('ai response cache tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
