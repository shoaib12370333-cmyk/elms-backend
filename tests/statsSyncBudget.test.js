// Ten big stores must fit into eBay's daily allowance: a store is read in a few calls (200 listings each), every call is taken from the
// daily budget, the background run rotates its start, skips idle owners and stops when the day's share is gone.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- database and eBay stand-ins ----
let listings = [];          // the Listing rows of the store being synced
let publishedAccounts = []; // the stores that have published listings (the background job asks for them)
const bulkOps = [];
const singleUpdates = [];
stub('models/schemas/Listing', {
  find: () => { const q = { select: () => q, lean: async () => listings.map((l) => ({ ...l })) }; return q; },
  bulkWrite: async (ops) => { bulkOps.push(...ops); },
  updateOne: async (filter, update) => { singleUpdates.push({ filter, set: update.$set }); },
  distinct: async () => publishedAccounts,
});
let token = 'rt';
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: async () => token });

let pagesByMarketplace = {};   // marketplace -> [{ items, totalPages }] per page
const bulkCalls = [];
const traffic = [];
let bulkError = null;
stub('services/ebayStatsService', {
  fetchActiveListingStats: async (rt, marketplaceId, page) => {
    bulkCalls.push({ marketplaceId, page });
    if (bulkError) throw bulkError;
    const pages = pagesByMarketplace[marketplaceId] || [{ items: [], totalPages: 1 }];
    const p = pages[page - 1] || { items: [], totalPages: pages.length };
    return { items: p.items, totalPages: pages.length };
  },
  fetchItemTraffic: async (rt, itemId, marketplaceId, opts) => { traffic.push({ itemId, opts }); return { watchers: 9, views: 77 }; },
});

let allowance = Infinity;      // calls the daily budget still grants
const reserved = [];
let snap = { day: '2026-09-26', limit: 5000, statsLimit: 3500, total: 0, stats: 0, exhausted: false };
stub('services/ebayCallBudget', {
  reserve: async (kind, n) => { reserved.push(kind); if (allowance < n) return false; allowance -= n; return true; },
  snapshot: async () => snap,
});

const { syncStatsForAccount, getLastRun, recordRun } = require('../services/listingStatsService');

const row = (i, over = {}) => ({ _id: 'L' + i, ebayListingId: String(1000 + i), marketplaceId: 'EBAY_GB', views: null, statsSyncedAt: null, viewsSyncedAt: null, ...over });
const items = (from, to, withViews) => Array.from({ length: to - from + 1 }, (_, k) => ({ itemId: String(1000 + from + k), watchers: (from + k) % 5, views: withViews ? 100 + from + k : null }));
const reset = () => {
  listings = []; bulkOps.length = 0; singleUpdates.length = 0; bulkCalls.length = 0; traffic.length = 0; reserved.length = 0;
  pagesByMarketplace = {}; bulkError = null; allowance = Infinity; token = 'rt';
};

(async () => {
  // ---------- 250 listings = 2 eBay calls, not 250; views come along when eBay sends them ----------
  reset();
  listings = Array.from({ length: 250 }, (_, i) => row(i + 1));
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 200, true), totalPages: 2 }, { items: items(201, 250, true), totalPages: 2 }];
  let r = await syncStatsForAccount('u1', 'A1');
  assert.strictEqual(bulkCalls.length, 2, 'two pages of 200 = two calls');
  assert.strictEqual(traffic.length, 0, 'no call per listing');
  assert.deepStrictEqual([r.synced, r.failed, r.calls, r.viewsInBulk, r.limited, r.error], [250, 0, 2, true, false, null]);
  assert.strictEqual(bulkOps.length, 250, 'one database write for all 250');
  const first = bulkOps.find((o) => o.updateOne.filter._id === 'L1').updateOne;
  assert.deepStrictEqual(first.filter, { _id: 'L1', userId: 'u1' }, 'only the owner\'s row is touched');
  assert.strictEqual(first.update.$set.views, 101); assert.strictEqual(first.update.$set.watchers, 1);
  assert.ok(first.update.$set.statsSyncedAt instanceof Date && first.update.$set.viewsSyncedAt instanceof Date);
  assert.deepStrictEqual(reserved, ['stats', 'stats'], 'each call was taken from the statistics budget');

  // ---------- eBay sends no view counts: a few are read one by one, oldest first, and never more than the cap ----------
  reset();
  listings = [row(1, { viewsSyncedAt: new Date('2026-09-20') }), row(2, { viewsSyncedAt: null }), row(3, { viewsSyncedAt: new Date('2026-09-10') }), row(4, { viewsSyncedAt: new Date('2026-09-25') }), row(5, { viewsSyncedAt: new Date('2026-09-01') })];
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 5, false), totalPages: 1 }];
  r = await syncStatsForAccount('u1', 'A1');
  assert.strictEqual(r.viewsInBulk, false);
  assert.deepStrictEqual(traffic.map((t) => t.itemId), ['1002', '1005', '1003'], 'never-read first, then the oldest, 3 in a run');
  assert.ok(traffic.every((t) => t.opts && t.opts.counted === true), 'those reads were reserved, so they are not counted twice');
  assert.strictEqual(r.calls, 4, '1 bulk + 3 single');
  assert.deepStrictEqual(reserved, ['stats', 'stats', 'stats', 'stats']);
  assert.strictEqual(singleUpdates.length, 3);
  assert.strictEqual(singleUpdates[0].set.views, 77); assert.ok(singleUpdates[0].set.viewsSyncedAt);
  traffic.length = 0; reserved.length = 0;
  await syncStatsForAccount('u1', 'A1', { viewsFallback: 0 });
  assert.strictEqual(traffic.length, 0, 'the fallback can be switched off');

  // ---------- the budget runs out: stop at once ----------
  reset();
  listings = Array.from({ length: 450 }, (_, i) => row(i + 1));
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 200, true), totalPages: 3 }, { items: items(201, 400, true), totalPages: 3 }, { items: items(401, 450, true), totalPages: 3 }];
  allowance = 1;
  r = await syncStatsForAccount('u1', 'A1');
  assert.strictEqual(bulkCalls.length, 1, 'the second page was not asked for');
  assert.strictEqual(r.limited, true);
  assert.strictEqual(r.synced, 200, 'what was read is still saved');
  assert.strictEqual(r.failed, 250);
  assert.strictEqual(traffic.length, 0, 'no fallback calls when the budget is gone');

  // ---------- eBay itself says the limit is reached ----------
  reset();
  listings = [row(1), row(2)];
  bulkError = Object.assign(new Error('Call usage limit has been reached.'), { limitReached: true });
  r = await syncStatsForAccount('u1', 'A1');
  assert.deepStrictEqual([r.limited, r.synced, r.error], [true, 0, 'Call usage limit has been reached.']);
  assert.strictEqual(traffic.length, 0, 'and it does not fall back to one call per listing');
  bulkError = Object.assign(new Error('eBay is down'), { statusCode: 502 });
  r = await syncStatsForAccount('u1', 'A1');
  assert.deepStrictEqual([r.limited, r.error, bulkCalls.length, traffic.length], [false, 'eBay is down', 2, 0], 'an ordinary failure ends the run for this store too');

  // ---------- listings eBay does not list (ended there) are left alone ----------
  reset();
  listings = [row(1), row(2), row(3)];
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 2, true).concat([{ itemId: '999999', watchers: 3, views: 5 }]), totalPages: 1 }];
  r = await syncStatsForAccount('u1', 'A1');
  assert.deepStrictEqual([r.synced, r.failed], [2, 1]);
  assert.ok(!bulkOps.some((o) => o.updateOne.filter._id === 'L3'), 'the missing one is not written');
  assert.ok(!bulkOps.some((o) => /999999/.test(JSON.stringify(o))), 'an item that is not in ELMS is ignored');

  // ---------- several marketplaces: the next one is only asked for what is still missing ----------
  reset();
  listings = [row(1), row(2, { marketplaceId: 'EBAY_US' })];
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 2, true), totalPages: 1 }]; // eBay returns both from the first site
  r = await syncStatsForAccount('u1', 'A1');
  assert.strictEqual(bulkCalls.length, 1, 'everything was found on the first marketplace');
  assert.strictEqual(r.synced, 2);
  reset();
  listings = [row(1), row(2, { marketplaceId: 'EBAY_US' })];
  pagesByMarketplace.EBAY_GB = [{ items: items(1, 1, true), totalPages: 1 }];
  pagesByMarketplace.EBAY_US = [{ items: items(2, 2, true), totalPages: 1 }];
  r = await syncStatsForAccount('u1', 'A1');
  assert.deepStrictEqual(bulkCalls.map((c) => c.marketplaceId), ['EBAY_GB', 'EBAY_US']);
  assert.strictEqual(r.synced, 2);

  // ---------- the page-open / button path: a store refreshed a minute ago is not asked from eBay again ----------
  reset();
  listings = [row(1, { statsSyncedAt: new Date(Date.now() - 60 * 1000) }), row(2, { statsSyncedAt: new Date(Date.now() - 3600 * 1000) })];
  r = await syncStatsForAccount('u1', 'A1', { minAgeMs: 120000 });
  assert.deepStrictEqual([r.fresh, r.calls, bulkCalls.length], [true, 0, 0]);
  r = await syncStatsForAccount('u1', 'A1', { minAgeMs: 30000 });
  assert.strictEqual(r.fresh, false, 'a shorter minimum age asks eBay');
  assert.strictEqual(bulkCalls.length, 1);

  // ---------- nothing to read / disconnected ----------
  reset();
  token = null;
  assert.strictEqual((await syncStatsForAccount('u1', 'A1')).error, 'account_disconnected');
  reset();
  assert.deepStrictEqual([(await syncStatsForAccount('u1', 'A1')).calls, bulkCalls.length], [0, 0], 'no live listings, no eBay call');

  // ---------- the background job ----------
  const sessionIds = new Set();
  let sessionFails = false;
  stub('models/schemas/Session', { distinct: async () => { if (sessionFails) throw new Error('db'); return [...sessionIds]; } });
  const accounts = ['a1', 'a2', 'a3', 'a4'].map((id, i) => ({ _id: id, userId: 'u' + (i + 1), ebayUserId: 'seller' + (i + 1) }));
  publishedAccounts = accounts.map((a) => a._id);
  stub('models/schemas/EbayAccount', { find: () => ({ lean: async () => accounts.slice() }) });
  const synced = [];
  let limitedAt = null;
  const svc = require('../services/listingStatsService');
  svc.syncStatsForAccount = async (userId, accountId) => { synced.push(accountId); return { synced: 10, failed: 0, calls: 1, viewsInBulk: false, limited: accountId === limitedAt }; };
  stub('services/jobLockService', { acquireLock: async () => true });
  const job = require('../jobs/statsSync');

  ['u1', 'u2', 'u3', 'u4'].forEach((u) => sessionIds.add(u));
  await job.runStatsSync();
  assert.deepStrictEqual(synced, ['a1', 'a2', 'a3', 'a4'], 'every active store is refreshed');
  assert.deepStrictEqual([getLastRun().stores, getLastRun().synced, getLastRun().calls, getLastRun().idleStores], [4, 40, 4, 0]);

  synced.length = 0;
  await job.runStatsSync();
  assert.strictEqual(synced[0], 'a2', 'the next run starts with another store, so the same ones do not always wait');
  assert.deepStrictEqual(synced.slice().sort(), ['a1', 'a2', 'a3', 'a4']);

  // an owner who has not used ELMS for two weeks is skipped
  synced.length = 0; sessionIds.delete('u3');
  await job.runStatsSync();
  assert.ok(!synced.includes('a3'), 'idle owner skipped');
  assert.strictEqual(getLastRun().idleStores, 1);
  // when the sessions cannot be read, everybody is refreshed rather than nobody
  synced.length = 0; sessionFails = true;
  const warn = console.warn; console.warn = () => {};
  await job.runStatsSync();
  console.warn = warn;
  assert.strictEqual(synced.length, 4);
  sessionFails = false;

  // the day's share is gone in the middle of a run: the remaining stores wait for tomorrow
  ['u1', 'u2', 'u3', 'u4'].forEach((u) => sessionIds.add(u));
  synced.length = 0; limitedAt = 'a4';
  await job.runStatsSync();
  const at = synced.indexOf('a4');
  assert.strictEqual(synced.length, at + 1, 'nothing runs after the store that hit the limit');
  assert.strictEqual(getLastRun().limited, true);
  limitedAt = null;

  // the budget is already used up (or eBay said so): the run does not even start
  synced.length = 0; snap = { ...snap, stats: 3500 };
  await job.runStatsSync();
  assert.strictEqual(synced.length, 0);
  assert.strictEqual(getLastRun().skipped, 'budget');
  snap = { ...snap, stats: 0, exhausted: true };
  await job.runStatsSync();
  assert.strictEqual(synced.length, 0, 'eBay said the limit is reached');

  assert.deepStrictEqual(job.rotate([1, 2, 3, 4], 5), [2, 3, 4, 1], 'rotation wraps around');
  assert.deepStrictEqual(job.rotate([], 3), []);
  recordRun({ synced: 1 });
  assert.ok(getLastRun().at, 'the last run has a time');

  console.log('stats sync budget: all good');
})().catch((err) => { console.error(err); process.exit(1); });
