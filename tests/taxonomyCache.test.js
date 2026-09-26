// eBay's Taxonomy API is counted against a daily limit: the same question is asked of eBay once (even when many ask at the same moment), the
// answers are kept in MongoDB too, an error is never kept, and when eBay says the limit is reached nothing more is sent for a few minutes.
// The real service runs; eBay (axios), the token and MongoDB are stand-ins.
const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- a MongoDB stand-in ----
const rows = new Map();
stub('models/schemas/TaxonomyCache', {
  findOne: (q) => ({ lean: async () => { const r = rows.get(q.key); return r && r.expireAt > new Date() ? r : null; } }),
  updateOne: async (q, u) => { rows.set(q.key, { key: q.key, ...u.$set }); },
});
const usage = [];
stub('models/schemas/ApiUsage', { updateOne: (q, u) => { usage.push({ key: q.key, inc: u.$inc.total }); return Promise.resolve(); } });
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });
stub('services/ebayAuthService', { getAppAccessToken: async () => 'app-token', getAccessToken: async () => 't' });

// ---- an eBay stand-in ----
const axios = require('axios');
const calls = [];
let fail = null; // () => error to throw
axios.get = async (url) => {
  calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
  await new Promise((r) => setTimeout(r, 15));
  if (fail) { const f = fail(); if (f) throw f; }
  if (url.includes('get_default_category_tree_id')) return { data: { categoryTreeId: '3' } };
  if (url.includes('get_item_aspects_for_category')) {
    const values = Array.from({ length: 150 }, (_, i) => ({ localizedValue: 'V' + i }));
    return { data: { aspects: [{ localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true, aspectUsage: 'REQUIRED', aspectMode: 'FREE_TEXT' }, aspectValues: values }] } };
  }
  if (url.includes('get_category_suggestions')) return { data: { categorySuggestions: [{ category: { categoryId: '9355', categoryName: 'Kettles' }, categoryTreeNodeAncestors: [{ categoryName: 'Kitchen' }] }] } };
  if (url.includes('get_category_subtree')) return { data: { categorySubtreeNode: { category: { categoryName: 'Kettles' }, leafCategoryTreeNode: true } } };
  throw new Error('unexpected ' + url);
};
const limitError = (status, message) => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message }] } } });

const T = require('../services/ebayTaxonomyService');
const reset = () => { calls.length = 0; usage.length = 0; rows.clear(); T._memory.clear(); T._resetCoolDown(); fail = null; };

(async () => {
  // ---- 50 at once for one category: one tree call + one aspects call ----
  reset();
  const many = await Promise.all(Array.from({ length: 50 }, () => T.getItemAspectsForCategory(null, '9355', 'EBAY_GB')));
  assert.strictEqual(calls.length, 2, 'the tree id and the item specifics, once: ' + calls.join(' | '));
  assert.ok(many.every((r) => r === many[0]), 'everybody got the same answer');
  const def = many[0].aspects[0];
  assert.strictEqual(def.values.length, 100); assert.strictEqual(def.allValues.length, 150, 'the publish check still knows every allowed value');
  assert.ok(!JSON.stringify(def).includes('allValues'), 'and it never goes out in the JSON');
  assert.strictEqual(usage.length, 2, 'every call to eBay is counted'); assert.ok(/^taxonomy:\d{4}-\d{2}-\d{2}$/.test(usage[0].key));
  await T.getItemAspectsForCategory(null, '9355', 'EBAY_GB'); assert.strictEqual(calls.length, 2, 'the second time costs nothing');
  await T.getItemAspectsForCategory(null, '9355', 'EBAY_US'); assert.strictEqual(calls.length, 4, 'another marketplace is another question (its own tree and specifics)');

  // ---- MongoDB keeps it: after a restart (memory empty) eBay is not asked again ----
  T._memory.clear(); calls.length = 0;
  const again = await T.getItemAspectsForCategory(null, '9355', 'EBAY_GB');
  assert.strictEqual(calls.length, 0, 'served from MongoDB');
  assert.strictEqual(again.aspects[0].allValues.length, 150); assert.ok(!Object.keys(again.aspects[0]).includes('allValues'), 'allValues is restored as a hidden field');
  assert.strictEqual(again.aspects[0].name, 'Brand'); assert.strictEqual(again.categoryTreeId, '3');

  // ---- suggestions: the same search words once; other words are another question ----
  reset();
  const [a, b] = await Promise.all([T.suggestCategories(null, 'Electric Kettle 1.7L Stainless Steel', 'EBAY_GB'), T.suggestCategories(null, 'electric kettle 1.7l stainless steel', 'EBAY_GB')]);
  assert.strictEqual(calls.filter((c) => c.includes('get_category_suggestions')).length, 1); assert.strictEqual(a.topSuggestion.categoryId, '9355'); assert.strictEqual(b.topSuggestion.categoryId, '9355');
  await T.suggestCategories(null, 'Wooden Cutting Board', 'EBAY_GB'); assert.strictEqual(calls.filter((c) => c.includes('get_category_suggestions')).length, 2);
  await assert.rejects(() => T.suggestCategories(null, '  ', 'EBAY_GB'), /title or keywords are required/);
  await assert.rejects(() => T.getItemAspectsForCategory(null, '', 'EBAY_GB'), /categoryId is required/);

  // ---- category info ----
  reset();
  await Promise.all([T.getCategoryInfo(null, '9355', 'EBAY_GB'), T.getCategoryInfo(null, '9355', 'EBAY_GB')]);
  assert.strictEqual(calls.filter((c) => c.includes('get_category_subtree')).length, 1);
  assert.strictEqual((await T.getCategoryInfo(null, '9355', 'EBAY_GB')).isLeaf, true);

  // ---- an error is never kept: the next ask goes to eBay again ----
  reset(); let n = 0; fail = () => (n++ === 0 ? limitError(500, 'eBay is having a bad moment') : null);
  await assert.rejects(() => T.getCategoryInfo(null, '111', 'EBAY_GB'), /bad moment/);
  assert.strictEqual((await T.getCategoryInfo(null, '111', 'EBAY_GB')).name, 'Kettles');

  // ---- the limit: a clear message, and nothing more is sent for a while (cached answers still work) ----
  reset();
  await T.getItemAspectsForCategory(null, '9355', 'EBAY_GB'); // kept before the limit
  fail = () => limitError(429, 'Too many requests. The call limit has been reached.');
  await assert.rejects(() => T.suggestCategories(null, 'Something new here', 'EBAY_GB'), (e) => e.limitReached === true && e.statusCode === 429 && /daily limit for category lookups.*midnight Pacific/.test(e.message));
  calls.length = 0; fail = null;
  await assert.rejects(() => T.suggestCategories(null, 'Another new thing', 'EBAY_GB'), (e) => e.limitReached === true);
  assert.strictEqual(calls.length, 0, 'no call while it cools down');
  assert.strictEqual((await T.getItemAspectsForCategory(null, '9355', 'EBAY_GB')).aspects[0].name, 'Brand', 'what is kept still works');
  T._resetCoolDown();
  assert.strictEqual((await T.suggestCategories(null, 'Another new thing', 'EBAY_GB')).topSuggestion.categoryId, '9355', 'and it asks again after the cool-down');

  console.log('taxonomy cache tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
