// listingCloneService.js: clones an existing, already-categorized Listing (+ its Import) into another user's Draft, with no
// Easyparser/Canopy call - the shared primitive behind the admin's free "push listings" tool and the paid "Buy Listings" tab.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

let listings = [];
let imports = {};
stub('models/schemas/Listing', {
  find: (query) => ({
    lean: async () => listings.filter((l) => {
      if (query.sourcePlatform !== undefined && l.sourcePlatform !== query.sourcePlatform) return false;
      if (query.sourceCountry !== undefined && l.sourceCountry !== query.sourceCountry) return false;
      if (query.categoryId && query.categoryId.$ne === null && l.categoryId == null) return false;
      if (query.importId && query.importId.$ne === null && l.importId == null) return false;
      if (query.createdAt && query.createdAt.$gte && l.createdAt < query.createdAt.$gte) return false;
      if (query.userId !== undefined && l.userId !== query.userId) return false;
      return true;
    }).map((l) => ({ ...l })),
  }),
  findById: async (id) => listings.find((l) => l._id === id) || null,
});
stub('models/schemas/Import', {
  findById: async (id) => imports[id] || null,
});

let createdImports = [];
let updatedImages = [];
stub('models/importsModel', {
  createImport: async (userId, product, suggestedPrice, amazonUrl, ebayAccountId) => {
    const rec = { id: 'imp-' + (createdImports.length + 1), userId, product, suggestedPrice, amazonUrl, ebayAccountId };
    createdImports.push(rec);
    return rec;
  },
  updateImportImages: async (userId, id, images) => { updatedImages.push({ userId, id, images }); },
});

let createdDrafts = [];
let existingByUserSku = {};
stub('models/listingsModel', {
  upsertDraft: async (userId, fields) => {
    const draft = { id: 'draft-' + (createdDrafts.length + 1), userId, ...fields };
    createdDrafts.push(draft);
    return draft;
  },
  findListingInStore: async (userId, sku) => existingByUserSku[userId + ':' + sku] || null,
});

let activeAccounts = {};
stub('models/ebayAccountsModel', { getActiveEbayAccount: async (userId) => activeAccounts[userId] || null });

const svc = require('../services/listingCloneService');

function baseListing(over) {
  return {
    sourcePlatform: 'amazon',
    userId: 'seller',
    sku: 'B0AAAAAAAA',
    importId: 'i1',
    categoryId: '12345',
    createdAt: ago(1),
    title: 'A nice widget',
    description: 'Listing description',
    bulletPoints: ['from the listing'],
    specifications: [{ name: 'Color', value: 'Red' }],
    ebayAspects: { Brand: 'Acme' },
    sellPrice: 29.99,
    markupPercent: 50,
    currency: 'USD',
    amazonPrice: 19.99,
    marginAmount: 10,
    pricingRule: null,
    images: ['https://cdn.example/listing-copy.jpg'],
    mainImage: 'https://cdn.example/listing-copy.jpg',
    ...over,
  };
}

(async () => {
  // ---- candidatePool: distinct ASIN, categorized, recent, excludes the target's own + already-owned SKUs ----
  listings = [
    { _id: 'l1', ...baseListing({ sku: 'B0AAAAAAAA', importId: 'i1', userId: 'seller1' }) },
    { _id: 'l2', ...baseListing({ sku: 'B0BBBBBBBB', importId: 'i2', userId: 'seller2' }) }, // excluded by excludeSkus below
    { _id: 'l3', ...baseListing({ sku: 'B0AAAAAAAA', importId: 'i3', userId: 'seller3' }) }, // same ASIN as l1: deduped
    { _id: 'l4', ...baseListing({ sku: 'B0CCCCCCCC', importId: 'i4', userId: 'seller4', categoryId: null }) }, // no category: not ready
    { _id: 'l5', ...baseListing({ sku: 'B0DDDDDDDD', importId: null, userId: 'seller5' }) }, // no import: skip
    { _id: 'l6', ...baseListing({ sku: 'B0EEEEEEEE', importId: 'i6', userId: 'seller6', createdAt: ago(30) }) }, // outside the 7-day pool window
    { _id: 'l7', ...baseListing({ sku: 'B0FFFFFFFF', importId: 'i7', userId: 'target1' }) }, // already the target's own listing
  ];
  const pool = await svc.candidatePool({ excludeUserId: 'target1', excludeSkus: ['B0BBBBBBBB'] });
  assert.strictEqual(pool.length, 1, 'only l1 (B0BBBBBBBB excluded, B0AAAAAAAA deduped to one, no category / no import / too old / target\'s own all filtered)');
  assert.strictEqual(pool[0].sku, 'B0AAAAAAAA');

  // ---- cloneOneListing: builds a full draft from the source Listing + Import, images from the raw (Amazon CDN) product data ----
  imports.i1 = {
    amazonUrl: 'https://www.amazon.com/dp/B0AAAAAAAA',
    product: {
      asin: 'B0AAAAAAAA', title: 'Raw scraped title', price: 19.99, currency: 'USD',
      images: ['https://m.media-amazon.com/img1.jpg', 'https://m.media-amazon.com/img2.jpg'],
      description: 'raw scraped description', bulletPoints: ['raw bullet'], specifications: [], ebayAspects: {},
    },
  };
  let result = await svc.cloneOneListing({ _id: 'l1', importId: 'i1', sku: 'B0AAAAAAAA' }, 'buyer1');
  assert.ok(result && result.draft, 'clones successfully when the target does not already have this ASIN');
  assert.strictEqual(result.draft.categoryId, '12345', 'the category comes from the Listing, never left null like a real import');
  assert.strictEqual(result.draft.sku, 'B0AAAAAAAA');
  assert.strictEqual(result.draft.description, 'Listing description', 'prefers the Listing\'s own (seller-facing) fields over the raw scrape');
  assert.deepStrictEqual(createdImports[createdImports.length - 1].product.images, ['https://m.media-amazon.com/img1.jpg', 'https://m.media-amazon.com/img2.jpg'], 'images come from the raw Amazon CDN data, not a prior owner\'s locally re-hosted copies');
  assert.strictEqual(createdImports[createdImports.length - 1].userId, 'buyer1');
  assert.strictEqual(updatedImages[updatedImages.length - 1].images.length, 2);
  assert.strictEqual(createdDrafts[createdDrafts.length - 1].amazonUrl, 'https://www.amazon.com/dp/B0AAAAAAAA', 'the clone\'s own draft is told the ORIGINAL Amazon URL, so it gets the right sourceCountry too, not just the right content');

  // ---- cloneOneListing: skipped when the target already has this ASIN in an active state ----
  existingByUserSku['buyer2:B0AAAAAAAA'] = { status: 'published' };
  const draftsBefore = createdDrafts.length;
  result = await svc.cloneOneListing({ _id: 'l1', importId: 'i1', sku: 'B0AAAAAAAA' }, 'buyer2');
  assert.strictEqual(result, null, 'already listed for this buyer: nothing is cloned');
  assert.strictEqual(createdDrafts.length, draftsBefore, 'no draft was created');

  // ---- candidatePool: sourceCountry narrows the pool to one Amazon site, so a UK-focused store is never pushed US products ----
  listings = [
    { _id: 'c1', ...baseListing({ sku: 'B0UK000001', importId: 'iu1', userId: 'sellerUK', sourceCountry: 'UK' }) },
    { _id: 'c2', ...baseListing({ sku: 'B0US000001', importId: 'iu2', userId: 'sellerUS', sourceCountry: 'US' }) },
  ];
  const ukOnly = await svc.candidatePool({ sourceCountry: 'UK' });
  assert.deepStrictEqual(ukOnly.map((r) => r.sku), ['B0UK000001'], 'only the UK-sourced listing comes back');
  const anyCountry = await svc.candidatePool({});
  assert.strictEqual(anyCountry.length, 2, 'no sourceCountry given: both sites, as before');

  // ---- pushRandomListings: pushes at most `count`, and never a SKU the target already owns (even via a different seller's listing) ----
  createdDrafts = []; createdImports = []; updatedImages = []; existingByUserSku = {};
  listings = [
    { _id: 'p1', ...baseListing({ sku: 'B0P00000P1', importId: 'ip1', userId: 's1' }) },
    { _id: 'p2', ...baseListing({ sku: 'B0P00000P2', importId: 'ip2', userId: 's2' }) }, // same ASIN target2 already owns (below): must be skipped
    { _id: 'p3', ...baseListing({ sku: 'B0P00000P3', importId: 'ip3', userId: 's3' }) },
    { _id: 'p4', ...baseListing({ sku: 'B0P00000P2', importId: 'ip4', userId: 'target2' }) }, // target2's own existing listing for that ASIN
  ];
  imports = { ip1: { amazonUrl: 'u1', product: { asin: 'B0P00000P1', images: ['https://cdn/p1.jpg'] } },
    ip2: { amazonUrl: 'u2', product: { asin: 'B0P00000P2', images: ['https://cdn/p2.jpg'] } },
    ip3: { amazonUrl: 'u3', product: { asin: 'B0P00000P3', images: ['https://cdn/p3.jpg'] } } };

  const pushed = await svc.pushRandomListings({ targetUserId: 'target2', count: 2 });
  assert.strictEqual(pushed.requested, 2);
  assert.strictEqual(pushed.poolSize, 2, 'p2 dropped (target already owns that ASIN via p4), p4 dropped (target\'s own listing)');
  assert.strictEqual(pushed.pushed, 2);
  assert.ok(createdDrafts.every((d) => d.sku !== 'B0P00000P2'), 'the already-owned ASIN is never pushed again');

  // ---- pushRandomListings: sourceCountry reaches candidatePool, so a request for one Amazon site never pushes another's product ----
  createdDrafts = []; existingByUserSku = {};
  listings = [
    { _id: 'q1', ...baseListing({ sku: 'B0Q0000UK1', importId: 'iq1', userId: 'sellerUK2', sourceCountry: 'UK' }) },
    { _id: 'q2', ...baseListing({ sku: 'B0Q0000US1', importId: 'iq2', userId: 'sellerUS2', sourceCountry: 'US' }) },
  ];
  imports.iq1 = { amazonUrl: 'https://www.amazon.co.uk/dp/B0Q0000UK1', product: { asin: 'B0Q0000UK1', images: [] } };
  imports.iq2 = { amazonUrl: 'https://www.amazon.com/dp/B0Q0000US1', product: { asin: 'B0Q0000US1', images: [] } };
  const pushedUk = await svc.pushRandomListings({ targetUserId: 'target3', count: 5, sourceCountry: 'UK' });
  assert.strictEqual(pushedUk.poolSize, 1, 'only the UK-sourced one is in the pool');
  assert.strictEqual(createdDrafts[0].sku, 'B0Q0000UK1');

  // ---- pushRandomListings: count 0 / negative does nothing and never touches the database ----
  createdDrafts = [];
  const nothing = await svc.pushRandomListings({ targetUserId: 'target2', count: 0 });
  assert.deepStrictEqual(nothing, { requested: 0, poolSize: 0, pushed: 0 });
  assert.strictEqual(createdDrafts.length, 0);

  console.log('listingCloneService: all good');
})().catch((err) => { console.error(err); process.exit(1); });
