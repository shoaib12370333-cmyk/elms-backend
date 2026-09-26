// "The UPC field is missing" (eBay error 25002): nothing is sent for a barcode by default; after eBay names a missing identifier, that
// listing is published once more with "Does not apply" for it. The real body builder and the real publishOnEbay run; eBay is a stand-in.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const { missingIdentifiers, identifierFields } = require('../services/productIdentifiers');
const listing = require('../services/ebayListingService');

const UPC_MESSAGE = 'A user error has occurred. The UPC field is missing. Please add UPC to the listing and try again. (eBay error 25002) [0: The UPC field is missing., 1: The UPC field is missing. Please add UPC to the listing and try again., 2: 1, 3: UPC]';
const upcError = () => Object.assign(new Error(UPC_MESSAGE), { statusCode: 400, ebayErrors: [{ errorId: 25002, message: 'A user error has occurred. The UPC field is missing. Please add UPC to the listing and try again.', parameters: [{ name: '0', value: 'The UPC field is missing.' }, { name: '3', value: 'UPC' }] }] });

// ---- reading the error ----
assert.deepStrictEqual(missingIdentifiers(upcError()), ['upc'], 'the message eBay gave for a real listing');
assert.deepStrictEqual(missingIdentifiers(new Error('The EAN field is missing.')), ['ean']);
assert.deepStrictEqual(missingIdentifiers(new Error('UPC and ISBN are required for this category')), ['upc', 'isbn']);
assert.deepStrictEqual(missingIdentifiers(new Error('Invalid category (eBay error 25002)')), []);
assert.deepStrictEqual(missingIdentifiers(new Error('The item specific Brand is missing.')), [], 'another missing field is not an identifier');
assert.deepStrictEqual(missingIdentifiers(new Error('The UPC 12345 is not valid.')), [], 'an invalid barcode is not a missing one');
assert.deepStrictEqual(missingIdentifiers(null), []);

// ---- what is sent ----
const settings = { merchantLocationKey: 'loc1', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_GB' };
const product = { asin: 'B012345678', title: 'Kettle', description: 'Desc', images: ['https://img.example/1.jpg'] };
const plain = listing.buildListingBodies({ product, sellPrice: 20, quantity: 1, categoryId: '9355', sellerSettings: settings });
assert.ok(!('upc' in plain.inventoryItemBody.product) && !('ean' in plain.inventoryItemBody.product) && !('isbn' in plain.inventoryItemBody.product), 'nothing about a barcode by default');
const marked = listing.buildListingBodies({ product: { ...product, identifiersNotApplicable: ['upc'] }, sellPrice: 20, quantity: 1, categoryId: '9355', sellerSettings: settings });
assert.deepStrictEqual(marked.inventoryItemBody.product.upc, ['Does not apply']); assert.ok(!('ean' in marked.inventoryItemBody.product));
assert.deepStrictEqual(identifierFields({ identifiersNotApplicable: ['ean', 'isbn', 'bogus'] }), { ean: ['Does not apply'], isbn: ['Does not apply'] });
assert.deepStrictEqual(identifierFields({}), {});

// ---- publishOnEbay: one more try with "Does not apply", only for a missing identifier, only once ----
const singles = [];
let behaviour = () => ({ listingId: 'ok' });
stub('services/ebayListingService', {
  publishListing: async (a) => { singles.push(a); return behaviour(a); },
  createOrGetCustomLocation: async () => ({}), fulfillmentPolicyUsesCalculatedShipping: async () => false, buildListingBodies: () => ({}), describeEbayError: () => '', ebayRequest: async () => ({}),
});
stub('models/listingsModel', { listPublishingListings: async () => [], acquirePublishLease: async () => null, getListingById: async () => null, markPublished: async () => ({}), markError: async () => ({}), markPublishCreditCharged: async () => {}, updateListing: async () => {} });
stub('models/importsModel', { getImportById: async () => null });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => null, getEbayAccountRefreshToken: async () => 'rt' });
stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {} });
stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });
stub('services/publishPreflightService', { prepareAspects: async () => ({}), assertUsableCategory: async () => {} });
const bulk = require('../services/ebayBulkPublisher');
const { publishOnEbay } = require('../services/publishQueueService');
const FIRST = 4 * 60 * 1000;

(async () => {
  delete process.env.EBAY_BULK_PUBLISH;
  // the ordinary way: fails on UPC once, then goes with "Does not apply"
  behaviour = (a) => { if (!a.product.identifiersNotApplicable) throw upcError(); return { listingId: 'ok' }; };
  let out = await publishOnEbay({ timeoutMs: FIRST, product: { asin: 'B0' } });
  assert.strictEqual(out.listingId, 'ok'); assert.strictEqual(singles.length, 2);
  assert.deepStrictEqual(singles[1].product.identifiersNotApplicable, ['upc']); assert.strictEqual(singles[0].product.identifiersNotApplicable, undefined, 'the first try is unchanged');
  // still refused with the marked listing: not tried a third time, eBay's words are kept
  singles.length = 0; behaviour = () => { throw upcError(); };
  await assert.rejects(() => publishOnEbay({ timeoutMs: FIRST, product: { asin: 'B0' } }), /UPC field is missing/); assert.strictEqual(singles.length, 2);
  // any other error is not tried again here
  singles.length = 0; behaviour = () => { throw new Error('Invalid category (eBay error 25002)'); };
  await assert.rejects(() => publishOnEbay({ timeoutMs: FIRST, product: { asin: 'B0' } }), /Invalid category/); assert.strictEqual(singles.length, 1);
  // a listing that publishes fine is untouched
  singles.length = 0; behaviour = () => ({ listingId: 'ok' });
  await publishOnEbay({ timeoutMs: FIRST, product: { asin: 'B0' } }); assert.strictEqual(singles.length, 1); assert.strictEqual(singles[0].product.identifiersNotApplicable, undefined);
  // the bulk way: eBay's bulk answer says UPC is missing for this listing -> the ordinary way with "Does not apply"
  process.env.EBAY_BULK_PUBLISH = '1'; singles.length = 0; behaviour = () => ({ listingId: 'single' });
  let bulkCalls = 0; bulk.publish = async () => { bulkCalls += 1; throw upcError(); };
  out = await publishOnEbay({ timeoutMs: FIRST, product: { asin: 'B0' } });
  assert.strictEqual(out.listingId, 'single'); assert.strictEqual(bulkCalls, 1); assert.deepStrictEqual(singles[0].product.identifiersNotApplicable, ['upc']);

  console.log('upc identifiers tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
