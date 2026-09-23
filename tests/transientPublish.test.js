// eBay error 25001 ("A system error has occurred") is usually transient: retry once. Also, eBay's
// generic errors must show their `parameters` so the real cause is visible.
const assert = require('node:assert/strict');
const Module = require('module');

const fakeAxios = async () => {
  const err = new Error('Request failed with status code 500');
  err.response = { status: 500, data: { errors: [{ errorId: 25001, message: 'A system error has occurred.', longMessage: 'Internal Server Error', parameters: [{ name: 'field', value: 'listingDescription' }] }] } };
  throw err;
};
fakeAxios.post = fakeAxios;
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && /ebayListingService\.js/.test(parent.filename)) {
    if (request === 'axios') return fakeAxios;
    if (request === './ebayAuthService') return { getAccessToken: async () => 't' };
  }
  return origLoad.apply(this, arguments);
};
const { publishListing } = require('../services/ebayListingService');
Module._load = origLoad;
const { publishWithTransientRetry, isTransientEbayError } = require('../services/publishQueueService');

const ebayErr = (id, status = 500) => Object.assign(new Error('x'), { statusCode: status, ebayErrors: id ? [{ errorId: id }] : undefined });

(async () => {
  assert.equal(isTransientEbayError(ebayErr(25001)), true);
  assert.equal(isTransientEbayError(ebayErr(null, 503)), true);
  assert.equal(isTransientEbayError(ebayErr(25002, 400)), false, 'a real validation error is not retried');
  assert.equal(isTransientEbayError(new Error('plain')), false);

  // transient once -> second attempt (shorter deadline) succeeds
  let calls = 0; const seen = [];
  const flaky = async (args) => { calls += 1; seen.push(args.timeoutMs); if (calls === 1) throw ebayErr(25001); return { listingId: 'L1' }; };
  const ok = await publishWithTransientRetry(flaky, { timeoutMs: 240000 }, { delayMs: 1 });
  assert.equal(ok.listingId, 'L1');
  assert.equal(calls, 2);
  assert.deepEqual(seen, [240000, 120000]);

  // still failing after the one retry -> the error is reported, not retried forever
  calls = 0;
  await assert.rejects(() => publishWithTransientRetry(async () => { calls += 1; throw ebayErr(25001); }, {}, { delayMs: 1 }));
  assert.equal(calls, 2);

  // a non-transient error is thrown at once
  calls = 0;
  await assert.rejects(() => publishWithTransientRetry(async () => { calls += 1; throw ebayErr(25002, 400); }, {}, { delayMs: 1 }));
  assert.equal(calls, 1);

  // eBay's parameters / longMessage end up in the message
  const settings = { merchantLocationKey: 'l', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_US' };
  await assert.rejects(
    () => publishListing({ refreshToken: 'rt', product: { asin: 'B000000001', title: 'Test title', images: ['https://x.example/a.jpg'] }, sellPrice: 5, quantity: 1, categoryId: '9355', sku: 'AMZ-B000000001', sellerSettings: settings }),
    /25001\) \[Internal Server Error \| field: listingDescription\]/
  );

  console.log('transient publish tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
