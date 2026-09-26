// Which way a listing goes to eBay: with EBAY_BULK_PUBLISH on, a first attempt joins the bulk calls; a retry after a transient error (shorter
// deadline) and everything with the switch off go the ordinary one-at-a-time way.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const singleCalls = [];
stub('services/ebayListingService', {
  publishListing: async (a) => { singleCalls.push(a.timeoutMs); return { listingId: 'single' }; },
  createOrGetCustomLocation: async () => ({}), fulfillmentPolicyUsesCalculatedShipping: async () => false,
  buildListingBodies: () => ({}), describeEbayError: () => '', ebayRequest: async () => ({}),
});
stub('models/listingsModel', { listPublishingListings: async () => [], acquirePublishLease: async () => null, getListingById: async () => null, markPublished: async () => ({}), markError: async () => ({}), markPublishCreditCharged: async () => {}, updateListing: async () => {} });
stub('models/importsModel', { getImportById: async () => null });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => null, getEbayAccountRefreshToken: async () => 'rt' });
stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {} });
stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });
stub('services/publishPreflightService', { prepareAspects: async () => ({}), assertUsableCategory: async () => {} });

const bulk = require('../services/ebayBulkPublisher');
const bulkCalls = [];
bulk.publish = async (a) => { bulkCalls.push(a.timeoutMs); return { listingId: 'bulk' }; };
const { publishOnEbay, publishWithTransientRetry } = require('../services/publishQueueService');

(async () => {
  const FIRST = 4 * 60 * 1000;
  delete process.env.EBAY_BULK_PUBLISH;
  assert.strictEqual((await publishOnEbay({ timeoutMs: FIRST })).listingId, 'single', 'off: the ordinary way');
  process.env.EBAY_BULK_PUBLISH = '1';
  assert.strictEqual((await publishOnEbay({ timeoutMs: FIRST })).listingId, 'bulk', 'on: a first attempt joins the bulk calls');
  assert.strictEqual((await publishOnEbay({ timeoutMs: 2 * 60 * 1000 })).listingId, 'single', 'a retry (shorter deadline) is one listing on its own');

  // a transient error in the bulk answer: tried once more, and that second try is the ordinary one
  singleCalls.length = 0; bulkCalls.length = 0;
  let first = true;
  bulk.publish = async (a) => { bulkCalls.push(a.timeoutMs); if (first) { first = false; throw Object.assign(new Error('x'), { statusCode: 500, ebayErrors: [{ errorId: 25001 }] }); } return { listingId: 'bulk' }; };
  const out = await publishWithTransientRetry(publishOnEbay, { timeoutMs: FIRST }, { delayMs: 1 });
  assert.strictEqual(out.listingId, 'single'); assert.deepStrictEqual(bulkCalls, [FIRST]); assert.deepStrictEqual(singleCalls, [2 * 60 * 1000]);

  console.log('publish on ebay tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
