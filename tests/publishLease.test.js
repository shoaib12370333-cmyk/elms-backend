// One worker per listing: the instant publish, the background runner and the once-a-minute queue all come through
// processOneQueuedListing, and a listing stays "publishing" while it is worked on. Before, all of them could publish it at once
// (a double credit, two "published" notifications, or one failing and giving the credit back while the listing was live).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const { fakeModel } = require('./helpers/fakeMongo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms);
const ahead = (ms) => new Date(Date.now() + ms);

(async () => {
  // ================= the model: the real listingsModel over an in-memory Listing collection =================
  const rows = [];
  stub('models/schemas/Listing.js', fakeModel(rows));
  const lm = require('../models/listingsModel');
  const reset = (list) => { rows.length = 0; rows.push(...list.map((r) => ({ userId: 'u1', publishLeaseUntil: null, ...r }))); };
  const row = (id) => rows.find((r) => r._id === id);

  // taking the lease
  reset([
    { _id: 'A', status: 'publishing', publishStartedAt: ago(MIN) },
    { _id: 'B', status: 'publishing', publishStartedAt: ago(5 * MIN), publishLeaseUntil: ahead(5 * MIN) },
    { _id: 'C', status: 'publishing', publishStartedAt: ago(20 * MIN), publishLeaseUntil: ago(MIN) },
    { _id: 'D', status: 'draft' },
    { _id: 'E', status: 'published' },
  ]);
  assert.strictEqual((await lm.acquirePublishLease('u1', 'A')).id, 'A');
  assert.strictEqual(await lm.acquirePublishLease('u1', 'A'), null, 'a second worker is refused while the first holds it');
  assert.strictEqual(await lm.acquirePublishLease('u1', 'B'), null, 'held by somebody');
  assert.ok(await lm.acquirePublishLease('u1', 'C'), 'a lease that ran out (the worker died) is taken over');
  assert.strictEqual(await lm.acquirePublishLease('u1', 'D'), null, 'only a listing that is being published');
  assert.strictEqual(await lm.acquirePublishLease('u1', 'E'), null);
  assert.strictEqual(await lm.acquirePublishLease('somebody-else', 'C'), null, 'and only for its owner');

  // what the queue may publish: listings that have waited and that nobody holds
  reset([
    { _id: 'A', status: 'publishing', publishStartedAt: ago(MIN) }, // just claimed: the request or the runner that claimed it has it
    { _id: 'B', status: 'publishing', publishStartedAt: ago(10 * MIN), publishLeaseUntil: ahead(5 * MIN) }, // a worker holds it
    { _id: 'C', status: 'publishing', publishStartedAt: ago(10 * MIN) }, // waited, nobody has it (a restart lost the runner's memory)
    { _id: 'D', status: 'publishing', publishStartedAt: ago(12 * MIN), publishLeaseUntil: ago(MIN) }, // its worker died
    { _id: 'E', status: 'draft' },
  ]);
  assert.deepStrictEqual((await lm.listPublishingListings(50, 3)).map((l) => l.id), ['D', 'C'], 'oldest first, and not the ones just claimed or held');
  assert.deepStrictEqual((await lm.listPublishingListings(50, 0)).map((l) => l.id).sort(), ['A', 'C', 'D']);

  // stale listings are failed by ONE caller, which gets the listing back as it was (so the credit is refunded once)
  reset([
    { _id: 'S1', status: 'publishing', publishStartedAt: ago(40 * MIN), publishCreditCharged: true, sku: 'X' },
    { _id: 'S2', status: 'publishing', publishStartedAt: ago(40 * MIN), publishLeaseUntil: ahead(2 * MIN) },
    { _id: 'S3', status: 'publishing', publishStartedAt: ago(5 * MIN) },
  ]);
  assert.deepStrictEqual((await lm.listStalePublishingListings(30)).map((l) => l.id), ['S1'], 'not the one a worker holds, not the recent one');
  const first = await lm.failStalePublishingListing('u1', 'S1', 30);
  assert.strictEqual(first.publish_credit_charged, true, 'handed back as it was: whether a credit was charged is known');
  assert.strictEqual(row('S1').status, 'error');
  assert.strictEqual(row('S1').publishCreditCharged, false);
  assert.strictEqual(await lm.failStalePublishingListing('u1', 'S1', 30), null, 'the second caller gets nothing: nobody refunds twice');
  assert.strictEqual(await lm.failStalePublishingListing('u1', 'S2', 30), null, 'a worker holds it');
  assert.strictEqual(await lm.failStalePublishingListing('u1', 'S3', 30), null, 'not old enough');

  // a fresh claim starts without a worker; the end of a publish clears the lease
  reset([
    { _id: 'K', status: 'draft', publishLeaseUntil: ahead(5 * MIN) },
    { _id: 'M', status: 'publishing', publishLeaseUntil: ahead(5 * MIN) },
    { _id: 'N', status: 'publishing', publishLeaseUntil: ahead(5 * MIN) },
  ]);
  await lm.claimListingForPublishing('u1', 'K');
  assert.deepStrictEqual([row('K').status, row('K').publishLeaseUntil], ['publishing', null]);
  await lm.markPublished('u1', 'M', { offerId: 'o', listingId: 'l', ebayAccountId: 'acc' });
  assert.deepStrictEqual([row('M').status, row('M').publishLeaseUntil], ['published', null]);
  await lm.markError('u1', 'N', 'boom');
  assert.deepStrictEqual([row('N').status, row('N').publishLeaseUntil], ['error', null]);

  // ================= the service: one worker per listing =================
  const store = new Map();
  const spies = { spend: 0, refund: 0, notes: [] };
  let publishCalls = 0;
  let publishImpl;
  const defaultPublish = async () => { await sleep(30); return { offerId: 'o1', listingId: 'e1', imageUrls: [] }; };
  const queueArgs = [];
  stub('models/listingsModel.js', {
    listPublishingListings: async (limit, minAge) => { queueArgs.push([limit, minAge]); return [...store.values()].filter((l) => l.status === 'publishing').map((l) => ({ ...l })); },
    acquirePublishLease: async (userId, id) => { const l = store.get(id); if (!l || l.status !== 'publishing' || (l.lease && l.lease > Date.now())) return null; l.lease = Date.now() + 10 * MIN; return { ...l }; },
    getListingById: async (userId, id) => (store.has(id) ? { ...store.get(id) } : null),
    markPublishCreditCharged: async (userId, id, value) => { store.get(id).publish_credit_charged = !!value; },
    markPublished: async (userId, id, data) => { const l = store.get(id); Object.assign(l, { status: 'published', lease: null, publish_credit_charged: false, ebay_listing_id: data.listingId }); return { ...l }; },
    markError: async (userId, id, message) => { const l = store.get(id); Object.assign(l, { status: 'error', lease: null, error_message: message }); return { ...l }; },
  });
  stub('models/importsModel.js', { getImportById: async () => ({ amazon_url: 'https://www.amazon.com/dp/B000000001', product: { asin: 'B000000001', title: 'A good title for the item', images: ['https://m.media-amazon.com/images/I/a.jpg'], price: 10, specifications: [] } }) });
  stub('models/ebayAccountsModel.js', { getEbayAccountById: async () => ({ marketplaceId: 'EBAY_US', productLocationMode: 'merchant', merchantLocationKey: 'loc', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r' }), getEbayAccountRefreshToken: async () => 'rt' });
  stub('services/ebayListingService.js', { publishListing: async (args) => { publishCalls += 1; return publishImpl(args); }, createOrGetCustomLocation: async () => 'loc', fulfillmentPolicyUsesCalculatedShipping: async () => false });
  stub('models/usersModel.js', { hasCredits: async () => true, spendCredit: async () => { spies.spend += 1; return true; }, refundCredit: async () => { spies.refund += 1; } });
  stub('models/systemNotificationsModel.js', { createSystemNotification: async (userId, n) => { spies.notes.push(n.type); return {}; } });
  stub('services/publishPreflightService.js', { prepareAspects: async () => ({ aspects: null, notes: [] }), assertUsableCategory: async () => {} });
  const { processOneQueuedListing, processPublishQueue } = require('../services/publishQueueService');

  const listing = (over = {}) => ({ id: 'L1', userId: 'u1', status: 'publishing', ebay_account_id: 'acc1', import_id: 'imp1', category_id: '9355', sell_price: 20, quantity: 1, sku: 'B000000001', title: 'A good title for the item', marketplace_id: 'EBAY_US', currency: 'USD', publish_credit_charged: false, images: [], images_customized: false, description: 'desc', bullet_points: [], specifications: [], ebay_aspects: {}, use_dynamic_policies: false, lease: null, ...over });
  const setup = (...listings) => { store.clear(); listings.forEach((l) => store.set(l.id, l)); Object.assign(spies, { spend: 0, refund: 0, notes: [] }); publishCalls = 0; publishImpl = defaultPublish; queueArgs.length = 0; };
  const quiet = async (fn) => { const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

  // two workers get the same listing at the same moment: it is published once, charged once, reported once
  setup(listing());
  const snapshot = { ...store.get('L1') };
  const [r1, r2] = await quiet(() => Promise.all([processOneQueuedListing({ ...snapshot }), processOneQueuedListing({ ...snapshot })]));
  assert.strictEqual(publishCalls, 1, 'published once');
  assert.strictEqual(spies.spend, 1, 'charged once');
  assert.deepStrictEqual(spies.notes, ['publish_success'], 'reported once');
  assert.strictEqual(store.get('L1').status, 'published');
  assert.strictEqual(store.get('L1').lease, null);
  assert.ok([r1, r2].some((r) => r.status === 'published'), 'one of them did the work');
  assert.ok([r1, r2].some((r) => r.status === 'publishing'), 'the other one only looked and left it alone');

  // the caller's copy can be stale: the leased copy knows that an earlier worker already charged (then died), so nothing is charged twice
  setup(listing({ publish_credit_charged: true, lease: Date.now() - 1000 }));
  const done = await quiet(() => processOneQueuedListing(listing({ publish_credit_charged: false })));
  assert.strictEqual(done.status, 'published');
  assert.strictEqual(spies.spend, 0, 'not charged a second time');

  // a failure: the error is stored, the lease cleared, the credit given back once, one notification
  setup(listing());
  publishImpl = async () => { throw Object.assign(new Error('eBay says no'), { statusCode: 400 }); };
  const failed = await quiet(() => processOneQueuedListing({ ...store.get('L1') }));
  assert.strictEqual(failed.status, 'error');
  assert.match(failed.error_message, /eBay says no/);
  assert.strictEqual(store.get('L1').lease, null);
  assert.deepStrictEqual([spies.spend, spies.refund], [1, 1]);
  assert.deepStrictEqual(spies.notes, ['publish_failed']);

  // a listing that is no longer being published (another worker finished it) or is held by somebody is left alone
  setup(listing({ status: 'published' }));
  let out = await quiet(() => processOneQueuedListing({ ...store.get('L1'), status: 'publishing' }));
  assert.strictEqual(out.status, 'published');
  assert.deepStrictEqual([publishCalls, spies.spend, spies.notes.length], [0, 0, 0]);
  setup(listing({ lease: Date.now() + 5 * MIN }));
  out = await quiet(() => processOneQueuedListing({ ...store.get('L1') }));
  assert.strictEqual(out.status, 'publishing');
  assert.deepStrictEqual([publishCalls, spies.spend], [0, 0], 'held by another worker: nothing is done');

  // a worker that died leaves its lease behind: once it has run out, the queue publishes the listing
  setup(listing({ lease: Date.now() - MIN }));
  out = await quiet(() => processOneQueuedListing({ ...store.get('L1') }));
  assert.strictEqual(out.status, 'published');

  // the queue asks only for listings that have waited a while, and keeps its lease alive between them
  setup(listing({ id: 'Q1', lease: null }), listing({ id: 'Q2', lease: null }));
  let renewed = 0;
  const count = await quiet(() => processPublishQueue({ afterEach: async () => { renewed += 1; } }));
  assert.strictEqual(count, 2);
  assert.strictEqual(renewed, 2, 'after each listing');
  assert.deepStrictEqual(queueArgs[0], [50, 3], 'up to 50 listings, that have been "publishing" for at least 3 minutes');
  assert.deepStrictEqual([store.get('Q1').status, store.get('Q2').status], ['published', 'published']);

  // ================= the once-a-minute job: two overlapping runs refund a stale listing once =================
  const failedAlready = new Set();
  stub('models/listingsModel.js', {
    listStalePublishingListings: async () => [{ id: 'S1', userId: 'u1' }, { id: 'S2', userId: 'u1' }],
    failStalePublishingListing: async (userId, id) => { if (failedAlready.has(id)) return null; failedAlready.add(id); await sleep(5); return { id, userId, title: 'T' + id, publish_credit_charged: id === 'S1' }; },
  });
  stub('services/publishQueueService.js', { processPublishQueue: async () => 0 });
  const { runPublishQueue } = require('../jobs/publishQueue');
  setup();
  await quiet(() => Promise.all([runPublishQueue(), runPublishQueue()]));
  assert.strictEqual(spies.refund, 1, 'the credit that was charged came back once, not once per run');
  assert.deepStrictEqual(spies.notes, ['publish_failed', 'publish_failed'], 'each stale listing is reported once');

  console.log('publish lease tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
