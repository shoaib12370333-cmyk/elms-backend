// models/productCatalogModel.js: the Admin Panel > Product Catalog's own CRUD, plus pushCatalogItemToUserDrafts - the
// "push one catalog row into a chosen seller's Drafts, free, category carried over only when the marketplaces match"
// logic services/listingCloneService.js's own admin push already established (no credit charge; the row is left in
// place so it can be pushed again, to other sellers, until it expires). priceByRule and requireAsinSku are real;
// everything that touches the database is a hand-written in-memory stand-in.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let rows = [];
let seq = 0;
const reverseRows = () => [...rows].reverse(); // newest-created last in `rows`, so a reverse mirrors sort({createdAt:-1})
const matches = (row, query) => !query.marketplaceId || row.marketplaceId === query.marketplaceId;
stub('models/schemas/ProductCatalogItem', {
  create: async (fields) => { const doc = { _id: 'C' + (++seq), ...fields }; rows.push(doc); return doc; },
  find: (query = {}) => ({ sort: () => ({ skip: (n) => ({ limit: (l) => ({ lean: async () => reverseRows().filter((r) => matches(r, query)).slice(n, n + l) }) }) }) }),
  countDocuments: async (query = {}) => rows.filter((r) => matches(r, query)).length,
  findById: (id) => ({ lean: async () => rows.find((r) => r._id === id) || null }),
  deleteOne: async ({ _id }) => { const before = rows.length; rows = rows.filter((r) => r._id !== _id); return { deletedCount: before - rows.length }; },
  deleteMany: async ({ expiresAt }) => { const before = rows.length; rows = rows.filter((r) => !(expiresAt && expiresAt.$lte && r.expiresAt <= expiresAt.$lte)); return { deletedCount: before - rows.length }; },
  aggregate: async () => { const byMarket = new Map(); for (const r of rows) byMarket.set(r.marketplaceId, (byMarket.get(r.marketplaceId) || 0) + 1); return [...byMarket.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([_id, count]) => ({ _id, count })); },
});

const db = { drafts: [], imports: [], pricingRule: null };
stub('models/importsModel', {
  createImport: async (userId, product, suggestedPrice, amazonUrl, ebayAccountId) => { const imp = { id: 'IMP' + db.imports.length, userId, product, suggestedPrice, amazonUrl, ebayAccountId }; db.imports.push(imp); return imp; },
  updateImportImages: async () => {},
});
let existingListing = null; // null, or a single override used by the single-push tests
let existingAsins = new Set(); // asins the target "already owns" - used by the bulk-push tests
stub('models/listingsModel', {
  findListingInStore: async (userId, sku) => (existingListing || (existingAsins.has(sku) ? { status: 'published' } : null)),
  upsertDraft: async (userId, fields) => { const draft = { id: 'D' + db.drafts.length, userId, ...fields }; db.drafts.push(draft); return draft; },
});
let activeAccount = { id: 'acc1', label: 'My US Store', marketplaceId: 'EBAY_US' };
stub('models/ebayAccountsModel', { getActiveEbayAccount: async () => activeAccount });
stub('models/usersModel', { getPricingRule: async () => db.pricingRule });

const { createCatalogItem, listCatalogItems, listMarketplaceCounts, getCatalogItemById, deleteCatalogItem, deleteExpiredCatalogItems, pushCatalogItemToUserDrafts, pushCatalogItemsToUserDrafts } = require('../models/productCatalogModel');

const product = (over = {}) => ({ asin: 'B0CATALOG1', title: 'A nice gadget', description: 'Works well.', bulletPoints: ['Fast', 'Durable'], images: ['https://img/1.jpg'], price: 10, currency: 'USD', brand: 'Acme', specifications: [{ name: 'Color', value: 'Black' }], ...over });
const reset = () => { rows = []; seq = 0; db.drafts = []; db.imports = []; db.pricingRule = null; existingListing = null; existingAsins = new Set(); activeAccount = { id: 'acc1', label: 'My US Store', marketplaceId: 'EBAY_US' }; };

(async () => {
  // ---------- createCatalogItem: maps the normalized product + taxonomy into a row ----------
  reset();
  const saved = await createCatalogItem({ createdBy: 'admin1', product: product(), amazonUrl: 'https://www.amazon.com/dp/B0CATALOG1', country: 'US', marketplaceId: 'EBAY_US', categoryId: '123', categoryName: 'Gadgets', expiresAt: new Date(Date.now() + 86400000) });
  assert.strictEqual(saved.asin, 'B0CATALOG1');
  assert.strictEqual(saved.categoryId, '123');
  assert.strictEqual(saved.mainImage, 'https://img/1.jpg');
  assert.strictEqual(rows.length, 1);

  // ---------- listCatalogItems: newest first, paginated ----------
  reset();
  for (let i = 1; i <= 5; i += 1) await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0CATALOG' + i }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date() });
  let page = await listCatalogItems({ page: 1, limit: 2 });
  assert.strictEqual(page.total, 5);
  assert.strictEqual(page.pages, 3);
  assert.deepStrictEqual(page.items.map((i) => i.asin), ['B0CATALOG5', 'B0CATALOG4'], 'newest (last created) first');
  page = await listCatalogItems({ page: 2, limit: 2 });
  assert.deepStrictEqual(page.items.map((i) => i.asin), ['B0CATALOG3', 'B0CATALOG2']);

  // ---------- getCatalogItemById / deleteCatalogItem ----------
  reset();
  const one = await createCatalogItem({ createdBy: 'admin1', product: product(), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date() });
  assert.strictEqual((await getCatalogItemById(one.id)).asin, 'B0CATALOG1');
  assert.strictEqual(await deleteCatalogItem(one.id), true);
  assert.strictEqual(await getCatalogItemById(one.id), null);
  assert.strictEqual(await deleteCatalogItem(one.id), false, 'already gone');

  // ---------- deleteExpiredCatalogItems: only rows past their time are removed ----------
  reset();
  const now = Date.now();
  await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'OLD0000001' }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now - 1000) });
  await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'FRESH00001' }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now + 1000 * 60 * 60) });
  const removed = await deleteExpiredCatalogItems(new Date(now));
  assert.strictEqual(removed, 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].asin, 'FRESH00001');

  // ---------- pushCatalogItemToUserDrafts: happy path, same marketplace - category is carried over ----------
  reset();
  const item1 = await createCatalogItem({ createdBy: 'admin1', product: product(), country: 'US', marketplaceId: 'EBAY_US', categoryId: '9355', categoryName: 'Cell Phones', expiresAt: new Date(now + 86400000) });
  let out = await pushCatalogItemToUserDrafts(item1.id, 'seller1');
  assert.strictEqual(out.categoryCarried, true);
  assert.strictEqual(db.drafts.length, 1);
  assert.strictEqual(db.drafts[0].categoryId, '9355');
  assert.strictEqual(db.drafts[0].sku, 'B0CATALOG1');
  assert.strictEqual(db.drafts[0].sellPrice, 10, 'no pricing rule: 0% markup, raw price kept');
  assert.strictEqual(db.drafts[0].ebayAccountId, 'acc1');

  // ---------- different marketplace than the target seller's active store: draft is still created, but uncategorized ----------
  reset();
  const item2 = await createCatalogItem({ createdBy: 'admin1', product: product(), country: 'GB', marketplaceId: 'EBAY_GB', categoryId: '555', categoryName: 'Phones', expiresAt: new Date(now + 86400000) });
  activeAccount = { id: 'acc2', label: 'My US Store', marketplaceId: 'EBAY_US' }; // the seller's store is US, the catalog row's category is UK-resolved
  out = await pushCatalogItemToUserDrafts(item2.id, 'seller2');
  assert.strictEqual(out.categoryCarried, false);
  assert.strictEqual(db.drafts[0].categoryId, null, 'a UK category id would not be valid on a US store - not carried over');

  // ---------- the target seller's own pricing rule prices the pushed draft, same as a fresh import ----------
  reset();
  const item3 = await createCatalogItem({ createdBy: 'admin1', product: product({ price: 20 }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now + 86400000) });
  db.pricingRule = { enabled: true, currency: 'USD', profitPercent: 20, profitFixed: 2, feePercent: 13, feeFixed: 0.3, shipping: 0 };
  out = await pushCatalogItemToUserDrafts(item3.id, 'seller3');
  assert.ok(db.drafts[0].sellPrice > 20, 'the rule priced it above cost');
  assert.ok(db.drafts[0].pricingRule, 'the rule snapshot is kept on the draft, same as a normal import');

  // ---------- already listed in that seller's store: refused, nothing created ----------
  reset();
  const item4 = await createCatalogItem({ createdBy: 'admin1', product: product(), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now + 86400000) });
  existingListing = { status: 'published' };
  await assert.rejects(() => pushCatalogItemToUserDrafts(item4.id, 'seller4'), (err) => { assert.strictEqual(err.statusCode, 409); assert.ok(err.alreadyListed); return true; });
  assert.strictEqual(db.drafts.length, 0);
  assert.strictEqual(db.imports.length, 0);

  // ---------- catalog item not found ----------
  reset();
  await assert.rejects(() => pushCatalogItemToUserDrafts('nope', 'seller5'), (err) => { assert.strictEqual(err.statusCode, 404); return true; });

  // ---------- listCatalogItems / listMarketplaceCounts: the Admin Panel's per-marketplace sections ----------
  reset();
  await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0US000001' }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now + 86400000) });
  await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0US000002' }), country: 'US', marketplaceId: 'EBAY_US', expiresAt: new Date(now + 86400000) });
  await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0GB000001' }), country: 'GB', marketplaceId: 'EBAY_GB', expiresAt: new Date(now + 86400000) });
  assert.deepStrictEqual(await listMarketplaceCounts(), [{ marketplaceId: 'EBAY_GB', count: 1 }, { marketplaceId: 'EBAY_US', count: 2 }]);
  let filtered = await listCatalogItems({ marketplaceId: 'EBAY_US' });
  assert.strictEqual(filtered.total, 2);
  assert.ok(filtered.items.every((i) => i.marketplaceId === 'EBAY_US'));
  filtered = await listCatalogItems({ marketplaceId: 'EBAY_GB' });
  assert.strictEqual(filtered.total, 1);
  assert.strictEqual((await listCatalogItems({})).total, 3, 'no filter: every marketplace');

  // ---------- pushCatalogItemsToUserDrafts (bulk): the target's existing products are skipped, not treated as a batch failure ----------
  reset();
  const bulkA = await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0BULKA001' }), country: 'US', marketplaceId: 'EBAY_US', categoryId: '1', categoryName: 'A', expiresAt: new Date(now + 86400000) });
  const bulkB = await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0BULKB001' }), country: 'US', marketplaceId: 'EBAY_US', categoryId: '2', categoryName: 'B', expiresAt: new Date(now + 86400000) });
  const bulkC = await createCatalogItem({ createdBy: 'admin1', product: product({ asin: 'B0BULKC001' }), country: 'US', marketplaceId: 'EBAY_US', categoryId: '3', categoryName: 'C', expiresAt: new Date(now + 86400000) });
  existingAsins = new Set(['B0BULKB001']); // the target seller already has product B
  const bulkOut = await pushCatalogItemsToUserDrafts([bulkA.id, bulkB.id, bulkC.id, 'not-a-real-id'], 'seller6');
  assert.deepStrictEqual(bulkOut.summary, { pushed: 2, alreadyHave: 1, failed: 0, notFound: 1 });
  const byId = Object.fromEntries(bulkOut.results.map((r) => [r.id, r]));
  assert.strictEqual(byId[bulkA.id].status, 'pushed');
  assert.strictEqual(byId[bulkB.id].status, 'already_have');
  assert.match(byId[bulkB.id].reason, /already/i);
  assert.strictEqual(byId[bulkC.id].status, 'pushed');
  assert.strictEqual(byId['not-a-real-id'].status, 'not_found');
  assert.strictEqual(db.drafts.length, 2, 'only the two not already owned were actually created');
  assert.deepStrictEqual(db.drafts.map((d) => d.sku).sort(), ['B0BULKA001', 'B0BULKC001']);

  console.log('product catalog model tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
