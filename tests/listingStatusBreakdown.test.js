// listingsModel.listingStatusBreakdown: how many of one user's listings are in each status, zero-filled - used by the
// Admin Panel's User Lookup page.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let lastMatch = null;
stub('models/schemas/Listing', {
  aggregate: async (pipeline) => {
    lastMatch = pipeline[0].$match;
    // Only one user in this fake collection has any listings; everyone else is empty, same as a real query.
    if (String(lastMatch.userId) !== 'a'.repeat(24)) return [];
    return [{ _id: 'published', count: 7 }, { _id: 'draft', count: 3 }, { _id: 'sold', count: 2 }];
  },
});

const { listingStatusBreakdown } = require('../models/listingsModel');

(async () => {
  const ID = 'a'.repeat(24);
  const counts = await listingStatusBreakdown(ID);
  assert.deepStrictEqual(counts, { draft: 3, publishing: 0, scheduled: 0, published: 7, paused: 0, error: 0, ended: 0, sold: 2 }, 'every status is present, zero-filled where there are none');
  assert.strictEqual(String(lastMatch.userId), ID, 'the user id is cast to a real ObjectId for the aggregate $match');

  const empty = await listingStatusBreakdown('b'.repeat(24));
  assert.deepStrictEqual(empty, { draft: 0, publishing: 0, scheduled: 0, published: 0, paused: 0, error: 0, ended: 0, sold: 0 });

  // ---- an optional accountId narrows the $match to one connected eBay store (the Admin Lookup per-store breakdown) ----
  const ACC = 'c'.repeat(24);
  await listingStatusBreakdown(ID, ACC);
  assert.strictEqual(String(lastMatch.userId), ID);
  assert.strictEqual(String(lastMatch.ebayAccountId), ACC, 'the account id is also cast to a real ObjectId');

  console.log('listingStatusBreakdown: all good');
})().catch((err) => { console.error(err); process.exit(1); });
