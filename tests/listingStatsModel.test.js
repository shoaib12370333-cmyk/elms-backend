// Saving eBay traffic on a listing: a number eBay did not send (null) must never overwrite a real count with 0.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let saved;
stub('models/schemas/Listing', { findOneAndUpdate: async (filter, update) => { saved = { filter, update }; return { toObject: () => ({ _id: 'L1', ...update }), ...update, _id: 'L1' }; } });
const { updateListingStats } = require('../models/listingsModel');

(async () => {
  await updateListingStats('u1', 'L1', { views: 120, watchers: 4 });
  assert.deepStrictEqual(saved.filter, { _id: 'L1', userId: 'u1' });
  assert.strictEqual(saved.update.views, 120); assert.strictEqual(saved.update.watchers, 4);
  assert.ok(saved.update.statsSyncedAt instanceof Date);
  assert.strictEqual(saved.update.viewsSyncedAt, saved.update.statsSyncedAt, 'a saved view count says when it was read');

  await updateListingStats('u1', 'L1', { views: null, watchers: 3 });
  assert.ok(!('views' in saved.update), 'eBay sent no view count: the stored one is kept (Number(null) is 0)');
  assert.ok(!('viewsSyncedAt' in saved.update));
  assert.strictEqual(saved.update.watchers, 3);

  await updateListingStats('u1', 'L1', { views: 0, watchers: 0 });
  assert.strictEqual(saved.update.views, 0, 'a real zero is kept');
  assert.strictEqual(saved.update.watchers, 0);

  await updateListingStats('u1', 'L1', { views: -5, watchers: 2.9 });
  assert.strictEqual(saved.update.views, 0, 'never negative'); assert.strictEqual(saved.update.watchers, 2, 'whole numbers');

  console.log('listing stats model: all good');
})().catch((err) => { console.error(err); process.exit(1); });
