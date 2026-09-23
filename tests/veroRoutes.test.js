// GET /vero-words serves the pattern; POST /vero-clean charges nothing when there is nothing to remove and
// refuses an empty title. (The AI path itself is covered by veroClean.test.js.)
const assert = require('assert');
const Module = require('module');

const fakes = {
  '../models/listingsModel': { createListing: async () => null, updateListingSettings: async () => null, markPublished: async () => null, markError: async () => null, claimListingForPublishing: async () => null, updateListing: async () => null },
  '../models/ebayAccountsModel': { listEbayAccounts: async () => [], getActiveEbayAccount: async () => null, getEbayAccountRefreshToken: async () => null, getEbayAccountById: async () => null },
  '../models/importsModel': { getImportById: async () => null, updateImportProduct: async () => null },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.listOnEbay.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listOnEbay');
Module._load = origLoad;

const handler = (method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, method + ' ' + path + ' is registered');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  let res = fakeRes();
  handler('get', '/vero-words')({ userId: 'u1' }, res);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.count > 200);
  assert.ok(new RegExp(res.body.pattern.source, res.body.pattern.flags).test('cheap nike shoes'));

  res = fakeRes();
  await handler('post', '/vero-clean')({ userId: 'u1', body: { title: '  ' } }, res);
  assert.strictEqual(res.statusCode, 400);

  res = fakeRes();
  await handler('post', '/vero-clean')({ userId: 'u1', body: { title: 'Plain wooden table', description: 'A table.' } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.unchanged, true);
  assert.strictEqual(res.body.creditsUsed, 0);
  console.log('vero routes tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
