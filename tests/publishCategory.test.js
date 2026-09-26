// Publishing a draft that has no eBay category (the Drafts page only suggests one for the cards it shows): the publish takes eBay's
// suggestion for the title, saves it on the draft and goes on; it only fails, with a reason a person can act on, when eBay has none.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let suggest = async () => ({ topSuggestion: { categoryId: '9355', categoryName: 'Cell Phones' } });
const suggestCalls = [];
stub('services/ebayTaxonomyService', { suggestCategories: async (t, title, mp) => { suggestCalls.push({ title, mp }); return suggest(title, mp); }, getItemAspectsForCategory: async () => ({ aspects: [] }) });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => ({ marketplaceId: 'EBAY_GB' }), getEbayAccountRefreshToken: async () => 'rt' });

const { ensureDraftCategory } = require('../services/draftCategoryService');

// ---- the service on its own ----
const saves = [];
const save = async (u, id, fields) => { saves.push({ u, id, fields }); };
const draft = (over = {}) => ({ id: 'L1', title: 'Blue Kettle 1.7L Stainless Steel', category_id: null, marketplace_id: null, ebay_account_id: 'A1', ...over });

(async () => {
  // a draft that has a category is left alone: nothing is asked, nothing is saved
  let out = await ensureDraftCategory('u1', draft({ category_id: '177' }), { save });
  assert.deepStrictEqual([out.categoryId, out.picked], ['177', false]); assert.strictEqual(suggestCalls.length, 0); assert.strictEqual(saves.length, 0);

  // none: eBay's suggestion, asked for the store's marketplace, saved on the draft
  out = await ensureDraftCategory('u1', draft(), { save });
  assert.deepStrictEqual([out.categoryId, out.categoryName, out.picked], ['9355', 'Cell Phones', true]);
  assert.deepStrictEqual(suggestCalls, [{ title: 'Blue Kettle 1.7L Stainless Steel', mp: 'EBAY_GB' }], 'the store\'s marketplace');
  assert.deepStrictEqual(saves, [{ u: 'u1', id: 'L1', fields: { categoryId: '9355' } }]);

  // eBay is busy twice, then answers: it is asked again (3 tries), and it works
  suggestCalls.length = 0; saves.length = 0;
  let n = 0;
  suggest = async () => { n += 1; if (n < 3) throw new Error('eBay is busy'); return { topSuggestion: { categoryId: '20625', categoryName: 'Kettles' } }; };
  out = await ensureDraftCategory('u1', draft(), { save, retryDelayMs: 1 });
  assert.strictEqual(out.categoryId, '20625'); assert.strictEqual(n, 3);

  // eBay stays busy: a clear reason, nothing saved
  saves.length = 0;
  suggest = async () => { throw new Error('eBay is busy'); };
  await assert.rejects(() => ensureDraftCategory('u1', draft(), { save, retryDelayMs: 1 }), /could not suggest one right now \(eBay is busy\).*choose a category in the editor/);
  assert.strictEqual(saves.length, 0);

  // eBay has no suggestion: asked once (the same answer again is no use), a reason that says what to do
  n = 0; suggest = async () => { n += 1; return { topSuggestion: null }; };
  await assert.rejects(() => ensureDraftCategory('u1', draft(), { save, retryDelayMs: 1 }), /eBay had no suggestion for this title.*choose a category/);
  assert.strictEqual(n, 1);
  // no title to suggest from
  await assert.rejects(() => ensureDraftCategory('u1', draft({ title: '  ' }), { save }), /no title to suggest one from/);

  // ---- the publish worker uses it ----
  const errors = []; const workerSaves = [];
  let listingRow;
  stub('models/listingsModel', {
    listPublishingListings: async () => [], getListingById: async () => listingRow, markPublished: async () => ({}), markPublishCreditCharged: async () => {},
    acquirePublishLease: async () => listingRow,
    markError: async (u, id, message) => { errors.push(message); return { id, status: 'error', error_message: message }; },
    updateListing: async (u, id, fields) => { workerSaves.push({ id, fields }); },
  });
  stub('models/importsModel', { getImportById: async () => null }); // stops the publish right after the category step, with its own message
  stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {} });
  stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });
  stub('services/ebayListingService', { publishListing: async () => ({}), createOrGetCustomLocation: async () => ({}), fulfillmentPolicyUsesCalculatedShipping: async () => false });
  stub('services/publishPreflightService', { prepareAspects: async () => ({}), assertUsableCategory: async () => {} });
  const { processOneQueuedListing } = require('../services/publishQueueService');
  const base = () => ({ id: 'L9', userId: 'u1', status: 'publishing', title: 'Steel Water Bottle 1L', ebay_account_id: 'A1', import_id: 'I1', sell_price: 20, category_id: null, publish_credit_charged: false });

  suggest = async () => ({ topSuggestion: { categoryId: '36021', categoryName: 'Bottles' } });
  listingRow = base();
  await processOneQueuedListing(listingRow);
  assert.deepStrictEqual(workerSaves, [{ id: 'L9', fields: { categoryId: '36021' } }], 'the suggested category is saved on the draft');
  assert.deepStrictEqual(errors, ['The linked Amazon product data could not be found.'], 'the publish went PAST the category step (it stops later, at the product)');

  errors.length = 0; workerSaves.length = 0;
  suggest = async () => ({ topSuggestion: null });
  listingRow = base();
  await processOneQueuedListing(listingRow);
  assert.strictEqual(workerSaves.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /^No eBay category is set, and eBay had no suggestion for this title/, 'the person is told what to do, not just "no category ID"');

  // a draft that already has its category does not ask eBay at all
  errors.length = 0; suggestCalls.length = 0;
  listingRow = { ...base(), category_id: '177' };
  await processOneQueuedListing(listingRow);
  assert.strictEqual(suggestCalls.length, 0);
  assert.deepStrictEqual(errors, ['The linked Amazon product data could not be found.']);

  console.log('publish category tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
