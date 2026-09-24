// GET /vero-words serves the pattern of the user's own words (null when they saved none); POST /vero-clean charges nothing
// when there is nothing to remove and refuses an empty title. (The AI path is covered by veroClean.test.js.)
const assert = require('assert');
const Module = require('module');

let userWords = [];
const fakes = {
  '../models/listingsModel': { createListing: async () => null, updateListingSettings: async () => null, markPublished: async () => null, markError: async () => null, claimListingForPublishing: async () => null, updateListing: async () => null },
  '../models/ebayAccountsModel': { listEbayAccounts: async () => [], getActiveEbayAccount: async () => null, getEbayAccountRefreshToken: async () => null, getEbayAccountById: async () => null },
  '../models/importsModel': { getImportById: async () => null, updateImportProduct: async () => null },
  '../services/veroSettingsService': { getVeroWordsOf: async () => userWords },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.listOnEbay.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listOnEbay');
// the hook stays on: the routes load the word service lazily, on the first request

const handler = (method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, method + ' ' + path + ' is registered');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  // no words saved -> nothing is flagged
  let res = fakeRes();
  await handler('get', '/vero-words')({ userId: 'u1' }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.pattern, null);
  assert.strictEqual(res.body.count, 0);

  userWords = ['nike', 'apple'];
  res = fakeRes();
  await handler('get', '/vero-words')({ userId: 'u1' }, res);
  assert.strictEqual(res.body.count, 2);
  const { source, flags } = res.body.pattern;
  assert.ok(new RegExp(source, flags).test('cheap nike shoes'));
  assert.ok(new RegExp(source, flags).test('an apple a day'));
  assert.ok(!new RegExp(source, flags).test('adidas shoes'), 'a word the user did not save is not flagged');

  res = fakeRes();
  await handler('post', '/vero-clean')({ userId: 'u1', body: { title: '  ' } }, res);
  assert.strictEqual(res.statusCode, 400);

  res = fakeRes();
  await handler('post', '/vero-clean')({ userId: 'u1', body: { title: 'Plain wooden table', description: 'A table.' } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.unchanged, true);
  assert.strictEqual(res.body.creditsUsed, 0);

  // a listing with none of THIS user's words is unchanged even if it names a famous brand
  res = fakeRes();
  await handler('post', '/vero-clean')({ userId: 'u1', body: { title: 'Gucci belt', description: 'Leather.' } }, res);
  assert.strictEqual(res.body.data.unchanged, true);
  console.log('vero routes tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
