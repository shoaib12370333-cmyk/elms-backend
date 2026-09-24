// Publishing in the background: the route claims the listing and answers at once (202); a runner does the slow part with at most
// 3 publishes at a time and serves users in turn; the page reads the result back from GET /publish-status.
const assert = require('assert');
const Module = require('module');

const claims = [];
let statusRows = [];
const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async (u, id) => (id === 'missing' ? null : { id, status: 'draft' }),
    getListingStatuses: async (u, ids) => statusRows.filter((r) => ids.includes(r.id)),
    claimListingForPublishing: async (u, id) => { claims.push(id); return id === 'taken' ? null : { id, status: 'publishing' }; },
    markPublished: async () => null, markError: async () => null, markPaused: async () => null, resetErrorToDraft: async () => null,
    deleteListing: async () => null, scheduleListing: async () => null, unscheduleListing: async () => null, updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../services/publishQueueService': { processOneQueuedListing: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.listings\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;
const runner = require('../services/publishRunner');

const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- the runner ----------
  const started = []; const finished = []; const failed = [];
  let release = {};
  runner.hooks.process = (listing) => new Promise((resolve, reject) => {
    started.push(listing.id);
    release[listing.id] = { ok: () => { finished.push(listing.id); resolve({ id: listing.id, status: 'published' }); }, boom: () => reject(new Error('eBay down')) };
  });
  runner.hooks.fail = async (userId, id, message) => { failed.push([userId, id, message]); };

  // alice queues 5, bob queues 2: at most 3 run at once, and bob is served in turn (not after all five of alice's)
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.strictEqual(runner.enqueuePublish('alice', { id }), true);
  for (const id of ['b1', 'b2']) assert.strictEqual(runner.enqueuePublish('bob', { id }), true);
  assert.strictEqual(runner.enqueuePublish('alice', { id: 'a1' }), false, 'a listing already waiting or running is not queued twice');
  await tick();
  assert.deepStrictEqual(started, ['a1', 'a2', 'a3'], 'three at a time');
  assert.deepStrictEqual(runner.stats(), { running: 3, waiting: 4 });

  // a place frees up: the turn is alice's (she was first in line), then bob's, then alice's again, then bob's
  release.a1.ok(); await tick(); await tick();
  assert.deepStrictEqual(started.slice(3), ['a4']);
  release.a2.boom(); await tick(); await tick();
  assert.deepStrictEqual(failed, [['alice', 'a2', 'eBay down']], 'a publish that throws marks the listing failed, with the reason');
  assert.deepStrictEqual(started.slice(4), ['b1'], 'bob is served before the fifth of alice');
  release.a3.ok(); await tick(); await tick();
  assert.deepStrictEqual(started.slice(5), ['a5']);
  release.a4.ok(); await tick(); await tick();
  assert.deepStrictEqual(started.slice(6), ['b2']);
  for (const id of ['b1', 'a5', 'b2']) release[id].ok();
  await tick(); await tick(); await tick();
  assert.deepStrictEqual(runner.stats(), { running: 0, waiting: 0 });
  assert.strictEqual(runner.enqueuePublish('alice', { id: 'a1' }), true, 'once it is done it can be queued again (a retry)');
  release.a1.ok(); await tick(); await tick();

  // ---------- the route ----------
  // hand the runner something quick so the route test does not depend on the above
  let queued = [];
  runner.hooks.process = async (listing) => { queued.push(listing.id); return {}; };
  const publish = handler('post', '/:id/publish');
  let res = fakeRes();
  await publish({ userId: 'u1', params: { id: 'l1' }, body: { background: true } }, res);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.queued, true);
  assert.strictEqual(res.body.listing.status, 'publishing');
  await tick(); await tick();
  assert.deepStrictEqual(queued, ['l1'], 'handed to the runner');

  res = fakeRes();
  await publish({ userId: 'u1', params: { id: 'taken' }, body: { background: true } }, res);
  assert.strictEqual(res.statusCode, 409, 'a listing that cannot be claimed is not queued');
  res = fakeRes();
  await publish({ userId: 'u1', params: { id: 'missing' }, body: { background: true } }, res);
  assert.strictEqual(res.statusCode, 404);
  await tick();
  assert.deepStrictEqual(queued, ['l1']);

  // without the flag the publish is still done before the answer, as before
  res = fakeRes();
  await publish({ userId: 'u1', params: { id: 'l2' }, body: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.queued, undefined);

  // ---------- the status route ----------
  statusRows = [{ id: 'l1', status: 'published', error_message: null }, { id: 'l2', status: 'error', error_message: 'Item specifics: Brand is missing' }, { id: 'l3', status: 'publishing', error_message: null }];
  res = fakeRes();
  await handler('get', '/publish-status')({ userId: 'u1', query: { ids: 'l1,l2,l3,zzz' } }, res);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.statuses.map((s) => s.status), ['published', 'error', 'publishing']);
  assert.match(res.body.statuses[1].error_message, /Brand is missing/);
  // it is registered above GET /:id, or /publish-status would be read as a listing called "publish-status"
  const order = router.stack.filter((x) => x.route && x.route.methods.get).map((x) => x.route.path);
  assert.ok(order.indexOf('/publish-status') < order.indexOf('/:id'), 'route order');

  console.log('background publish tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
