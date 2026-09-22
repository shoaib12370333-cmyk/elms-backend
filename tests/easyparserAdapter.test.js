// Checks the Easyparser adapter's response parsing and normalization. No network calls -
// axios.post/get are monkey-patched on the shared axios module instance.
const assert = require('assert');
const axios = require('axios');

process.env.EASYPARSER_API_KEY = 'test-key';
const svc = require('../services/easyparserAmazonService');

(async () => {
  // --- domain mapping ---
  assert.strictEqual(svc.toEasyparserDomain('US'), '.com');
  assert.strictEqual(svc.toEasyparserDomain('GB'), '.co.uk');
  assert.strictEqual(svc.toEasyparserDomain('ZZ'), '.com', 'unknown country falls back to .com');

  // --- submitBulkDetail: accepted + rejected parsing ---
  let seenBody, seenHeaders;
  axios.post = async (url, body, opts) => {
    seenBody = body; seenHeaders = opts.headers;
    return {
      data: {
        success: true,
        meta_data: { total_count: 3, accepted_count: 2, invalid_count: 1 },
        data: {
          accepted: [{ domain: '.com', results: [{ id: 'q1', asin: 'B0000001', credit: 1 }, { id: 'q2', asin: 'B0000002', credit: 1 }] }],
          invalid: [{ domain: '.com', results: [{ asin: 'B0000003', message: 'Invalid ASIN' }] }],
        },
      },
    };
  };
  const result = await svc.submitBulkDetail([{ domain: '.com', asins: ['B0000001', 'B0000002', 'B0000003'] }], 'https://x/cb');
  assert.strictEqual(seenHeaders['api-key'], 'test-key');
  assert.strictEqual(seenBody[0].payload.asins.length, 3);
  assert.deepStrictEqual(result.accepted.map((a) => a.asin).sort(), ['B0000001', 'B0000002']);
  assert.strictEqual(result.accepted.find((a) => a.asin === 'B0000001').queryId, 'q1');
  assert.strictEqual(result.rejected.length, 1);
  assert.strictEqual(result.rejected[0].asin, 'B0000003');
  assert.strictEqual(result.rejected[0].reason, 'Invalid ASIN');

  // empty input never calls the network
  axios.post = async () => { throw new Error('should not be called'); };
  const empty = await svc.submitBulkDetail([{ domain: '.com', asins: [] }]);
  assert.deepStrictEqual(empty, { accepted: [], rejected: [], meta: null });

  // --- pollResult: pending / success / failure ---
  axios.get = async () => ({ data: { data: { status: 'pending' } } });
  assert.deepStrictEqual(await svc.pollResult('q1'), { status: 'pending' });

  axios.get = async () => ({ data: { data: { status: 'success', json_result: { result: { asin: 'B0000001', title: 'Test' } } } } });
  const ok = await svc.pollResult('q1');
  assert.strictEqual(ok.status, 'success');
  assert.strictEqual(ok.raw.asin, 'B0000001');

  axios.get = async () => ({ data: { data: { status: 'failure', json_result: { request_info: { error_details: [{ message: 'Not found' }] } } } } });
  const fail = await svc.pollResult('q1');
  assert.strictEqual(fail.status, 'failure');
  assert.strictEqual(fail.error, 'Not found');

  axios.get = async () => { const e = new Error('network down'); e.response = undefined; throw e; };
  const netFail = await svc.pollResult('q1');
  assert.strictEqual(netFail.status, 'failure');

  // --- normalizeDetail: defensive field extraction ---
  const raw = {
    asin: 'B0000001',
    title: 'Wireless Mouse',
    description: 'A mouse.',
    feature_bullets: ['Ergonomic', 'Long battery'],
    images: [{ link: 'https://img/1.jpg' }, 'https://img/2.jpg'],
    main_image: { url: 'https://img/main.jpg' },
    buybox_winner: { price: { value: 19.99, currency: 'USD' }, availability: { in_stock: true } },
    rating: 4.5,
    ratings_total: 120,
    brand: 'Acme',
    specifications: [{ name: 'Color', value: 'Black' }, { name: '', value: 'skip me' }],
    categories: [{ name: 'Electronics' }, 'Computers'],
    variants: [{ asin: 'B0000002', title: 'Red', image: { link: 'https://img/red.jpg' } }],
  };
  const product = svc.normalizeDetail(raw, 'https://amazon.com/dp/B0000001');
  assert.strictEqual(product.asin, 'B0000001');
  assert.strictEqual(product.title, 'Wireless Mouse');
  assert.deepStrictEqual(product.bulletPoints, ['Ergonomic', 'Long battery']);
  assert.deepStrictEqual(product.images, ['https://img/main.jpg', 'https://img/1.jpg', 'https://img/2.jpg'], 'main image first, no duplicates');
  assert.strictEqual(product.price, 19.99);
  assert.strictEqual(product.currency, 'USD');
  assert.strictEqual(product.availability, 'In Stock');
  assert.strictEqual(product.rating, 4.5);
  assert.strictEqual(product.ratingsTotal, 120);
  assert.strictEqual(product.brand, 'Acme');
  assert.deepStrictEqual(product.specifications, [{ name: 'Color', value: 'Black' }], 'blank-name spec is dropped');
  assert.deepStrictEqual(product.categories, ['Electronics', 'Computers']);
  assert.strictEqual(product.variants[0].asin, 'B0000002');
  assert.strictEqual(product.variants[0].image, 'https://img/red.jpg');

  // price given as a plain string/number fallback still parses
  const raw2 = { asin: 'B2', buybox_winner: { price: '$9.50', availability: 'Out of Stock' } };
  const p2 = svc.normalizeDetail(raw2);
  assert.strictEqual(p2.price, 9.5);
  assert.strictEqual(p2.availability, 'Out of Stock');

  console.log('easyparser adapter tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
