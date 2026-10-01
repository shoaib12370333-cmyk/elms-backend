// db.js's one-time startup migration: every Amazon listing imported before the sourceCountry field existed gets it filled
// in from its own linked Import.amazonUrl (the same source of truth the live supplier_country badge already reads) - so the
// admin push-listings pool, and any future "only UK products" filter, can find OLD listings too, not just ones imported from
// now on. Idempotent, and never touches a listing that already carries the field (even a null one, from a URL it couldn't
// place) or one whose source isn't Amazon.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let rows = [];
const updates = [];
const Listing = {
  find: (filter, projection) => ({
    populate: () => ({
      cursor: () => rows.filter((r) => {
        if (filter.sourcePlatform !== undefined && r.sourcePlatform !== filter.sourcePlatform) return false;
        if (filter.sourceCountry && filter.sourceCountry.$exists === false && Object.prototype.hasOwnProperty.call(r, 'sourceCountry')) return false;
        if (filter.importId && filter.importId.$ne === null && r.importId == null) return false;
        return true;
      }).map((r) => ({ _id: r._id, importId: r.importId ? { amazonUrl: r.importId.amazonUrl } : null })),
    }),
  }),
  updateOne: async (filter, update) => {
    updates.push({ filter, update });
    const row = rows.find((r) => r._id === filter._id);
    if (row) Object.assign(row, update.$set);
  },
};
stub('models/schemas/Listing', Listing);

const { _migrateSourceCountryBackfill } = require('../db');

(async () => {
  rows = [
    { _id: 'l1', sourcePlatform: 'amazon', importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0UK' } }, // no sourceCountry field at all: legacy, needs backfill
    { _id: 'l2', sourcePlatform: 'amazon', importId: { amazonUrl: 'https://www.amazon.com/dp/B0US' } },
    { _id: 'l3', sourcePlatform: 'amazon', sourceCountry: 'FR', importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0WRONG' } }, // already has it: never touched, even though the URL disagrees
    { _id: 'l4', sourcePlatform: 'amazon', importId: null }, // no Import at all: filtered out by the importId.$ne query, never reaches supplierCountryFromUrl
    { _id: 'l5', sourcePlatform: 'amazon', importId: { amazonUrl: 'https://not-amazon.example/x' } }, // Import exists but the URL matches no known Amazon site: left alone
    { _id: 'l6', sourcePlatform: 'cj', importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0CJ' } }, // not Amazon-sourced: never reaches a sourceCountry at all, filtered by sourcePlatform
  ];
  updates.length = 0;

  await _migrateSourceCountryBackfill();

  assert.strictEqual(updates.length, 2, 'only the two resolvable legacy Amazon rows were written');
  assert.deepStrictEqual(updates.map((u) => u.filter._id).sort(), ['l1', 'l2']);
  assert.strictEqual(rows.find((r) => r._id === 'l1').sourceCountry, 'UK');
  assert.strictEqual(rows.find((r) => r._id === 'l2').sourceCountry, 'US');
  assert.strictEqual(rows.find((r) => r._id === 'l3').sourceCountry, 'FR', 'already-set value is never overwritten, even though it disagrees with the URL');
  assert.strictEqual(rows.find((r) => r._id === 'l5').sourceCountry, undefined, 'an unresolvable URL is left alone (no field written), not set to null');

  // ---- idempotent: running it again touches nothing more (l1/l2 now carry the field, so $exists:false no longer matches them) ----
  updates.length = 0;
  await _migrateSourceCountryBackfill();
  assert.strictEqual(updates.length, 0, 'a second run finds nothing left to backfill');

  console.log('migrateSourceCountryBackfill tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
