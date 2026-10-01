const crypto = require('crypto');

/**
 * A size-capped, TTL'd in-memory cache for AI answers - the same Map + FIFO-eviction pattern already used by
 * aiCategoryService.js's own `picks` cache and ebayTaxonomyService.js's memory tier, factored out here so
 * services/aiService.js's askClaude (the one place every AI feature in this codebase calls through) can cache every
 * answer the same way, instead of each of the 7+ AI services needing to build its own cache.
 *
 * Purely in-process and not persisted: a restart (or running on more than one instance) just means a cold cache,
 * never a correctness problem - it only ever saves re-asking something already answered recently with the exact
 * same words, never the only copy of anything. Bounded size is deliberate: see the OOM leak this same shape of
 * cache caused once before (services/ebayTaxonomyService.js, fixed in PR 165) when a cache had no cap at all.
 */
function makeCache({ ttlMs, max }) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) { store.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      store.delete(key); // re-insert at the end, so a freshly-written key is never the next one evicted
      store.set(key, { value, at: Date.now() });
      if (store.size > max) store.delete(store.keys().next().value);
    },
    get size() { return store.size; },
    _store: store,
  };
}

/** A short, stable key from any JSON-able value - object keys are sorted first, so the same data in a different property order still hits. */
function hashKey(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sort(v[k]); return o; }, {});
    return v;
  };
  return crypto.createHash('sha1').update(JSON.stringify(sort(value))).digest('hex');
}

module.exports = { makeCache, hashKey };
