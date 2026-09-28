// The public elmstool.com/track/<code> API: 404 for an unknown code, the cached status when it is fresh, a live
//17TRACK refresh when it is stale or missing - and never the real tracking number or carrier in the response.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let link = null;
let saved = null;
let getTrackInfoCalls = 0;
let getTrackInfoResult = { status: 'InTransit', detail: 'On its way', at: new Date('2026-03-01') };
stub('models/trackingLinksModel', {
  getByCode: async (code) => (link && String(code).toUpperCase() === link.code ? { ...link } : null),
  saveStatus: async (id, status) => { saved = { id, status }; },
});
stub('services/track17Service', {
  getTrackInfo: async (num, carrier) => { getTrackInfoCalls++; return getTrackInfoResult; },
  registerTracking: async () => { throw new Error('not used here'); },
  statusFromTrackInfo: () => null,
});
const router = require('../routes/publicTracking');
const handler = router.stack.find((l) => l.route && l.route.path === '/:code' && l.route.methods.get).route.stack[0].handle;
const call = async (code) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { code } }, res);
  return res;
};

(async () => {
  // unknown code
  let res = await call('ELM99999');
  assert.strictEqual(res.statusCode, 404);

  // a code that exists but 17TRACK never accepted (registration failed) - no carrier17, so no live call is even tried
  link = { code: 'ELM11111', trackingNumber: 'SECRET123', carrier17: null, status: null, statusDetail: null, statusAt: null, registeredAt: null };
  res = await call('elm11111'); // lower-case, as a buyer might type it
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['code', 'status', 'statusAt', 'statusDetail', 'success'].sort(), 'never leaks trackingNumber or carrier17');
  assert.strictEqual(res.body.status, 'NotAvailable');
  assert.strictEqual(getTrackInfoCalls, 0);

  // registered but no status fetched yet -> live refresh happens, and gets saved
  link = { code: 'ELM22222', trackingNumber: 'SECRET456', carrier17: 100003, status: null, statusDetail: null, statusAt: null, registeredAt: new Date() };
  res = await call('ELM22222');
  assert.strictEqual(getTrackInfoCalls, 1);
  assert.strictEqual(res.body.status, 'InTransit');
  assert.strictEqual(res.body.statusDetail, 'On its way');
  assert.ok(saved && saved.status.status === 'InTransit', 'the fresh status is cached back to the DB');

  // fresh cached status (just updated) -> no live call, cached value returned as-is
  getTrackInfoCalls = 0;
  link = { code: 'ELM33333', trackingNumber: 'SECRET789', carrier17: 100003, status: 'Delivered', statusDetail: 'Left at door', statusAt: new Date(), registeredAt: new Date() };
  res = await call('ELM33333');
  assert.strictEqual(getTrackInfoCalls, 0, 'a fresh cached status is not re-fetched');
  assert.strictEqual(res.body.status, 'Delivered');

  // stale cached status -> refreshed
  link = { code: 'ELM44444', trackingNumber: 'SECRETABC', carrier17: 100003, status: 'InTransit', statusDetail: 'old', statusAt: new Date(Date.now() - 2 * 60 * 60 * 1000), registeredAt: new Date() };
  getTrackInfoResult = { status: 'Delivered', detail: 'Delivered today', at: new Date() };
  res = await call('ELM44444');
  assert.strictEqual(res.body.status, 'Delivered', 'stale status is refreshed');

  // a live refresh that fails still returns the last known (stale) status rather than erroring the page
  stub('services/track17Service', { getTrackInfo: async () => { throw new Error('17TRACK is down'); }, registerTracking: async () => null, statusFromTrackInfo: () => null });
  delete require.cache[require.resolve('../routes/publicTracking')];
  const router2 = require('../routes/publicTracking');
  const handler2 = router2.stack.find((l) => l.route && l.route.path === '/:code' && l.route.methods.get).route.stack[0].handle;
  link = { code: 'ELM55555', trackingNumber: 'X', carrier17: 100003, status: 'InTransit', statusDetail: 'still going', statusAt: new Date(Date.now() - 2 * 60 * 60 * 1000), registeredAt: new Date() };
  const res2 = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler2({ params: { code: 'ELM55555' } }, res2);
  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.status, 'InTransit', 'falls back to the last known status, not an error page');

  console.log('public tracking route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
