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

  // images wrapped in an object (e.g. { list: [...] }) instead of a plain array are still found
  const raw3 = { asin: 'B3', images: { list: [{ hires: 'https://img/a.jpg' }, { original: 'https://img/b.jpg' }] }, main_image: 'https://img/main3.jpg' };
  const p3 = svc.normalizeDetail(raw3);
  assert.deepStrictEqual(p3.images, ['https://img/main3.jpg', 'https://img/a.jpg', 'https://img/b.jpg']);

  // --- the shapes Easyparser documents for DETAIL ---
  // images: [{ link, variant }] (several pictures), main_image: { link: <image id only> }
  const doc = {
    asin: 'B0DOC00001',
    title: 'Stanley Quencher 40 oz',
    images: [
      { link: 'https://m.media-amazon.com/images/I/411OJyT+xRL._AC_.jpg', variant: 'SIDE' },
      { link: 'https://m.media-amazon.com/images/I/31J5v542jbL._AC_.jpg', variant: 'MAIN' },
      { link: 'https://m.media-amazon.com/images/I/31xAZitd75L._AC_SL1500_.jpg', variant: 'BACK' },
      { link: 'https://m.media-amazon.com/images/I/31J5v542jbL._AC_SL1500_.jpg', variant: 'PT01' },
    ],
    main_image: { link: '31J5v542jbL' },
    buybox_winner: { price: { symbol: '$', value: 45, currency: 'USD', raw: '$45.00' }, availability: { raw: 'In Stock', min_quantity: 20, real_count: false } },
    specifications: [{ name: 'Brand', value: 'STANLEY' }, { name: 'Color', value: 'Toast' }],
    attributes: [{ name: 'Style', value: '40 oz' }, { name: 'Brand', value: 'STANLEY' }],
    weight: '1.79 pounds', dimensions: '5.28"W x 12.3"H', manufacturer: 'Stanley', model_number: 'ST-40',
    variants: [
      { asin: 'B0DOC00001', title: '40 Ounces Toast', is_current_product: true, link: 'https://amazon.com/dp/B0DOC00001', dimensions: [{ name: 'Size', value: '40 Ounces' }, { name: 'Color', value: 'Toast' }] },
      { asin: 'B0DOC00002', title: '30 Ounces Plum', is_current_product: false, link: 'https://amazon.com/dp/B0DOC00002', dimensions: [{ name: 'Size', value: '30 Ounces' }, { name: 'Color', value: 'Plum' }] },
      { title: 'no asin, dropped' },
    ],
  };
  const d = svc.normalizeDetail(doc, 'https://amazon.com/dp/B0DOC00001');
  assert.deepStrictEqual(d.images, [
    'https://m.media-amazon.com/images/I/31J5v542jbL.jpg',
    'https://m.media-amazon.com/images/I/411OJyT+xRL.jpg',
    'https://m.media-amazon.com/images/I/31xAZitd75L.jpg',
  ], 'the MAIN picture first, every other picture kept, original size, the same picture in two sizes once, the bare image id never a picture of its own');
  assert.ok(d.images.every((u) => u.startsWith('https://')), 'every image is a real link');
  assert.strictEqual(d.availability, 'In Stock', 'availability.raw is read');
  assert.strictEqual(d.price, 45);
  assert.deepStrictEqual(d.specifications.map((x) => x.name), ['Brand', 'Color', 'Style', 'Manufacturer', 'Item Weight', 'Product Dimensions', 'Item model number'], 'specifications + attributes, each name once, plus the plain facts (weight feeds calculated shipping)');
  assert.strictEqual(d.variants.length, 2, 'a variant without an ASIN is dropped');
  assert.strictEqual(d.variants[0].isCurrentProduct, true);
  assert.strictEqual(d.variants[1].title, '30 Ounces Plum');
  assert.deepStrictEqual(d.variants[1].dimensions, [{ name: 'Size', value: '30 Ounces' }, { name: 'Color', value: 'Plum' }]);
  // main_image alone (no images list) still gives one usable picture
  assert.deepStrictEqual(svc.normalizeDetail({ asin: 'B9', main_image: { link: '617ecXxEdeL' } }).images, ['https://m.media-amazon.com/images/I/617ecXxEdeL.jpg']);
  assert.deepStrictEqual(svc.normalizeDetail({ asin: 'B9' }).images, []);

  // the product may sit under result.detail
  axios.get = async () => ({ data: { data: { status: 'success', json_result: { result: { detail: { asin: 'B0DETAIL', title: 'Nested' } } } } } });
  const nested = await svc.pollResult('q9');
  assert.strictEqual(nested.raw.asin, 'B0DETAIL');

  console.log('easyparser adapter tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
