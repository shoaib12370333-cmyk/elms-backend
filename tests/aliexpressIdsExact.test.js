// A listing imported from AliExpress remembers that its 17-digit ids were read EXACTLY (services/jsonLongInts.js): the order service trusts
// such an id as it is, while an older listing (whose id may have been rounded as a plain JSON number) gets the extra rounded-twin check.
const assert = require('assert');
const Listing = require('../models/schemas/Listing');

assert.strictEqual(new Listing({ userId: '64f0c1e2a3b4c5d6e7f80901', sku: 'AE-1' }).aliexpressIdsExact, false, 'a listing nobody marked is treated as an older import');

const seen = { findOne: 0, update: null, filter: null };
Listing.findOne = async () => { seen.findOne += 1; return null; };
Listing.findOneAndUpdate = async (filter, update) => {
  seen.filter = filter; seen.update = update;
  return new Listing({ ...update, _id: '64f0c1e2a3b4c5d6e7f80999' });
};
const M = require('../models/listingsModel');

(async () => {
  const draft = await M.upsertAliexpressDraft('64f0c1e2a3b4c5d6e7f80901', {
    importId: null, ebayAccountId: null, marketplaceId: 'EBAY_US', aliexpressProductId: '1005003784285827', aliexpressSkuId: '12000027158136203',
    title: 'Widget', mainImage: null, images: [], sellPrice: 10, markupPercent: 20, currency: 'USD', quantity: 1, categoryId: null,
  });
  assert.strictEqual(seen.update.aliexpressIdsExact, true, 'a new import marks its ids as read exactly');
  assert.strictEqual(draft.aliexpress_ids_exact, true, 'and says so to the app / the order service');
  assert.strictEqual(draft.aliexpress_sku_id, '12000027158136203');
  assert.strictEqual(seen.filter.aliexpressSkuId, '12000027158136203');

  // a seller-edited draft re-imported keeps their edits but is marked too
  Listing.findOne = async () => new Listing({ userId: '64f0c1e2a3b4c5d6e7f80901', sourcePlatform: 'aliexpress', status: 'draft', draftCustomized: true, aliexpressProductId: '1005003784285827', aliexpressSkuId: '12000027158136203', sku: 'AE-12000027158136203' });
  await M.upsertAliexpressDraft('64f0c1e2a3b4c5d6e7f80901', { aliexpressProductId: '1005003784285827', aliexpressSkuId: '12000027158136203', title: 'New title', sellPrice: 99 });
  assert.strictEqual(seen.update.aliexpressIdsExact, true);
  assert.ok(!('title' in seen.update), 'the seller\'s own edits are untouched');

  console.log('aliexpress ids exact tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
