// models/listingsModel.js claimListingForPublishing: 'ended' was added to the claimable statuses (alongside the
// existing 'draft'/'error') so Live Listings' "Relist" (Ended tab) can reuse the exact same claim-then-queue publish
// pipeline Drafts' "Publish all" already uses (routes/listings.js POST /:id/publish and POST /publish-batch) -
// publishListing is safe to call again for a listing that already has a sku/offer (it finds and reuses the existing
// inventory item/offer rather than erroring on a duplicate, see services/publishQueueService.js).
const assert = require('assert');

let rows = {};
const seen = [];
const listingSchemaPath = require.resolve('../models/schemas/Listing');
require.cache[listingSchemaPath] = {
  id: listingSchemaPath, filename: listingSchemaPath, loaded: true,
  exports: {
    findOneAndUpdate: async (filter, update) => {
      seen.push(filter);
      const row = rows[filter._id];
      if (!row || row.userId !== filter.userId) return null;
      if (!filter.status.$in.includes(row.status)) return null;
      Object.assign(row, update.$set);
      return { ...row, toObject: () => ({ ...row }) };
    },
  },
};

const { claimListingForPublishing } = require('../models/listingsModel');
const reset = () => { rows = { l1: { _id: 'l1', userId: 'u1', status: 'ended' }, l2: { _id: 'l2', userId: 'u1', status: 'published' }, l3: { _id: 'l3', userId: 'u1', status: 'draft' } }; seen.length = 0; };

(async () => {
  // ---------- an ended listing can now be claimed for publishing (Relist) ----------
  reset();
  let claimed = await claimListingForPublishing('u1', 'l1');
  assert.ok(claimed, 'an ended listing is claimable');
  assert.strictEqual(claimed.status, 'publishing');
  assert.ok(seen[0].status.$in.includes('ended'), 'the query filter includes ended');

  // ---------- still never an already-live or already-publishing listing ----------
  reset();
  claimed = await claimListingForPublishing('u1', 'l2');
  assert.strictEqual(claimed, null, 'a published listing is not re-claimed');

  // ---------- a draft is unaffected by this change ----------
  reset();
  claimed = await claimListingForPublishing('u1', 'l3');
  assert.ok(claimed);
  assert.strictEqual(claimed.status, 'publishing');

  console.log('claim ended for relist tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
