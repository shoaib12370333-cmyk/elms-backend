// Deleting a listing whose eBay offer is already gone. Seen in production (2026-10-03, Render log): a Delete in Live Listings failed with
// "This Offer is not available. (eBay error 25713)" and the listing could never be removed from ELMS, because the offer it pointed at no
// longer existed on eBay (ended / deleted in Seller Hub, or an earlier delete that reached eBay but was never confirmed back).
// deleteOffer() now treats that one error as "nothing left to end" and the routes go on to remove the ELMS record; every other eBay error
// still stops the delete and keeps the listing. This runs the REAL ebayListingService (axios and the token call are stood in for) and the
// REAL single and bulk delete handlers (models stood in for).
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async () => 'AT' });
const sent = []; // every request that "went to eBay"
let responder = null; // (config) => result, or throws an axios-shaped error
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async (config) => { sent.push(config.method + ' ' + config.url.replace(/^https?:\/\/[^/]+/, '')); return responder(config); } };

const { deleteOffer, isOfferGoneError } = require('../services/ebayListingService');

const ebayFail = (status, errorId, message, parameters) => ({ response: { status, data: { errors: [{ errorId, message, parameters: parameters || [] }] } } });
const GONE = () => ebayFail(404, 25713, 'This Offer is not available.', [{ name: 'text1', value: '284081329011' }]); // the shape seen in production

// ---- the models the two route handlers read and write ----
const rows = {
  l1: { id: 'l1', title: 'Gone offer', status: 'active', ebay_offer_id: 'offer-gone', ebay_account_id: 'acc1' },
  l2: { id: 'l2', title: 'Fine offer', status: 'active', ebay_offer_id: 'offer-ok', ebay_account_id: 'acc1' },
  l3: { id: 'l3', title: 'eBay says no', status: 'active', ebay_offer_id: 'offer-bad', ebay_account_id: 'acc1' },
};
const removedOne = []; const removedMany = [];
const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async (_u, id) => rows[id] || null,
    getListingsForDelete: async (_u, ids) => ids.filter((id) => rows[id]).map((id) => rows[id]),
    deleteListing: async (_u, id) => { removedOne.push(id); return rows[id]; },
    deleteListingsMany: async (_u, ids) => { removedMany.push(...ids); return ids.length; },
    claimListingForPublishing: async () => null, markPublished: async () => null, markError: async () => null,
    markPaused: async () => null, resetErrorToDraft: async () => null,
    scheduleListing: async () => null, unscheduleListing: async () => null,
    updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'rt' },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes[\\/]listings\.js/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;
const findHandler = (method, p) => {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${p} route registered.`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const fakeRes = () => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };
const reset = () => { sent.length = 0; removedOne.length = 0; removedMany.length = 0; };

(async () => {
  // ---------- deleteOffer itself ----------
  responder = async () => { throw GONE(); };
  assert.deepStrictEqual(await deleteOffer('rt', 'offer-gone'), { alreadyGone: true }, 'an offer that is already gone is not an error');
  assert.deepStrictEqual(sent, ['DELETE /sell/inventory/v1/offer/offer-gone']);

  responder = async () => ({ data: '' }); // eBay's normal answer: 204 No Content
  assert.ok(!(await deleteOffer('rt', 'offer-ok'))?.alreadyGone, 'a normal delete is not reported as "already gone"');

  responder = async () => { throw ebayFail(400, 25002, 'Something else is wrong with the offer.'); };
  await assert.rejects(() => deleteOffer('rt', 'x'), /Something else is wrong/, 'any other eBay error still stops the delete');
  responder = async () => { throw ebayFail(500, 25001, 'System error.'); };
  await assert.rejects(() => deleteOffer('rt', 'x'), /System error/);
  responder = async () => { throw new Error('socket hang up'); };
  await assert.rejects(() => deleteOffer('rt', 'x'), /socket hang up/, 'a network failure is not "gone"');
  await assert.rejects(() => deleteOffer('rt', ''), /offerId is required/);

  // only the error ID counts, never the wording (the same words under another ID must not be taken for it)
  responder = async () => { throw ebayFail(400, 25999, 'This Offer is not available.'); };
  await assert.rejects(() => deleteOffer('rt', 'x'), /not available/, 'same words, different eBay error: still an error');
  responder = async () => { throw ebayFail(400, 25002, 'text mentions 25713'); };
  await assert.rejects(() => deleteOffer('rt', 'x'));
  // a 404 alone proves nothing (a wrong address or an unknown resource is a 404 too): only eBay's own "offer not available" ID counts
  responder = async () => { throw ebayFail(404, 25002, 'Resource not found.'); };
  await assert.rejects(() => deleteOffer('rt', 'x'), /Resource not found/, 'another 404 is still an error');
  responder = async () => { throw { response: { status: 404, data: '<html>Not Found</html>' } }; };
  await assert.rejects(() => deleteOffer('rt', 'x'), 'a 404 with no eBay error body is still an error');
  assert.strictEqual(isOfferGoneError({ ebayErrors: [{ errorId: '25713' }] }), true, 'eBay may send the ID as text');
  assert.strictEqual(isOfferGoneError({ ebayErrors: [{ errorId: 25002 }, { errorId: 25713 }] }), true);
  assert.strictEqual(isOfferGoneError({ ebayErrors: [] }), false);
  assert.strictEqual(isOfferGoneError({ message: '25713' }), false);
  assert.strictEqual(isOfferGoneError(null), false);

  // ---------- the single Delete (DELETE /api/listings/:id) ----------
  const single = findHandler('delete', '/:id');
  reset(); responder = async () => { throw GONE(); };
  let res = fakeRes();
  await single({ userId: 'u1', params: { id: 'l1' } }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success], [200, true], 'the stuck listing can be deleted');
  assert.deepStrictEqual(removedOne, ['l1'], 'and it is removed from ELMS');

  reset(); responder = async () => { throw ebayFail(400, 25002, 'eBay refused for another reason.'); };
  res = fakeRes();
  await single({ userId: 'u1', params: { id: 'l3' } }, res);
  assert.strictEqual(res.body.success, false); assert.match(res.body.error, /another reason/);
  assert.deepStrictEqual(removedOne, [], 'any other refusal keeps the listing');

  // ---------- the bulk Delete ----------
  const bulk = findHandler('post', '/bulk-delete');
  reset();
  responder = async (config) => {
    if (config.url.endsWith('/offer-gone')) throw GONE();
    if (config.url.endsWith('/offer-bad')) throw ebayFail(400, 25002, 'eBay refused for another reason.');
    return { data: '' };
  };
  res = fakeRes();
  await bulk({ userId: 'u1', body: { ids: ['l1', 'l2', 'l3'] } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.deletedCount, 2, 'the one with a vanished offer and the one eBay ended');
  assert.deepStrictEqual(removedMany.sort(), ['l1', 'l2']);
  assert.strictEqual(res.body.errors.length, 1); assert.ok(res.body.errors[0].includes('eBay says no') && /another reason/.test(res.body.errors[0]));

  console.log('delete-offer-already-gone tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
