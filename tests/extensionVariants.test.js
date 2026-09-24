// The extension's variant reading (extension/content.js), run against realistic page data: the colour / size picker's
// data block, the gallery data of a product page, a variant's own page, and a page that asks for a captcha.
// The real functions are cut out of content.js and run with a tiny fake page - nothing is re-implemented here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'markers: ' + from); return src.slice(a, b); };
const code = [
  between('  const clean = (value', '  function getAsin()'),
  between('  function parsePrice(value)', '  const PRODUCT_INFORMATION_NAMES'),
  between('  function normalizeImage(raw)', '  function collectImages()'),
  between('  function cleanProductTitle(value)', '  function extractProductTitle(json)'),
  between('  // ---------- variants:', '  function extract() {'),
].join('\n');

// ---- a tiny fake page ----
const el = (props = {}) => Object.assign({
  textContent: '', attrs: {}, kids: {},
  getAttribute(n) { return this.attrs[n] ?? null; },
  querySelector(sel) { return this.kids[sel] || null; },
  querySelectorAll(sel) { return this.lists?.[sel] || []; },
}, props);
const scriptEl = (t) => ({ textContent: t });
const page = (scripts, extra = {}) => ({ querySelectorAll: (sel) => (sel === 'script' ? scripts.map(scriptEl) : (extra.lists?.[sel] || [])), querySelector: (sel) => extra.kids?.[sel] || null });

// the data block Amazon puts in the page for the colour / size picker
const TWISTER = 'P.register("twister-js-init-dpx-data", function(){ var dataToReturn = ' + JSON.stringify({
  dimensionsDisplay: ['Colour', 'Size'],
  dimensions: ['color_name', 'size_name'],
  variationDisplayLabels: { color_name: 'Colour', size_name: 'Size' },
  dimensionValuesDisplayData: { B0BLACK001: ['Black', 'S'], B0BLACK002: ['Black', 'M'], B0WHITE001: ['White', 'S'], notAnAsin: ['x', 'y'] },
  parentAsin: 'B0PARENT01', currentAsin: 'B0BLACK001',
}) + '; return dataToReturn; });';

// the gallery data of a product page: Amazon writes 'colorImages' and 'initial' with single quotes and the pictures as JSON,
// with nested objects and arrays inside every picture entry (the hard part to cut out)
const GALLERY = "var data = {'colorImages': { 'initial': " + JSON.stringify(
  [
    { hiRes: 'https://m.media-amazon.com/images/I/AAA111._AC_SL1500_.jpg', thumb: 'https://m.media-amazon.com/images/I/AAA111._SS40_.jpg', large: 'https://m.media-amazon.com/images/I/AAA111._AC_.jpg', main: { 'https://m.media-amazon.com/images/I/AAA111._AC_SX679_.jpg': [679, 679] }, variant: 'MAIN' },
    { hiRes: null, large: 'https://m.media-amazon.com/images/I/BBB222._AC_.jpg', main: { 'https://m.media-amazon.com/images/I/BBB222._AC_SX679_.jpg': [679, 679] }, variant: 'PT01' },
    { main: { 'https://m.media-amazon.com/images/I/CCC333._AC_SX342_.jpg': [342, 342], 'https://m.media-amazon.com/images/I/CCC333._AC_SX679_.jpg': [679, 679] }, variant: 'PT02' },
    { videoUrl: 'https://v/x.mp4', hiRes: 'https://m.media-amazon.com/images/I/VID999._AC_.jpg', variant: 'VIDEO' },
  ]) + " }, 'colorToAsin': {}};";

const fetches = [];
let variantPages = {};
const ctx = {
  console, JSON, Math, Date, Promise, Object, Array, String, Number, RegExp, Set, Map, Error, URL, setTimeout, clearTimeout,
  location: { origin: 'https://www.amazon.com', href: 'https://www.amazon.com/dp/B0BLACK001' },
  document: null,
  getAsin: () => 'B0BLACK001',
  DOMParser: function () { this.parseFromString = (html) => variantPages[html]; },
  fetch: async (url) => {
    fetches.push(url);
    const asin = url.match(/\/dp\/([A-Z0-9]{10})/)[1];
    const page = variantPages[asin];
    if (page === 'FAIL') return { ok: false, text: async () => '' };
    if (page === 'CAPTCHA') return { ok: true, text: async () => 'Enter the characters you see below' };
    return { ok: true, text: async () => asin };
  },
};
vm.createContext(ctx);
vm.runInContext(code + '\nthis.api = { sliceJson, jsonAfterKey, readTwister, galleryFromScripts, collectVariantsQuick, enrichVariants, fetchVariantPage };', ctx);
// values made inside the vm have that realm's Object/Array: copy them over so deepStrictEqual compares like with like
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const api = { ...ctx.api, readTwister: (r) => plain(ctx.api.readTwister(r)), galleryFromScripts: (t) => plain(ctx.api.galleryFromScripts(t)), collectVariantsQuick: () => plain(ctx.api.collectVariantsQuick()) };

(async () => {
  // ---------- cutting JSON out of a script ----------
  assert.deepStrictEqual(JSON.parse(api.sliceJson('x = {"a":[1,2,{"b":"]}"}],"c":3}; more', 4)), { a: [1, 2, { b: ']}' }], c: 3 }, 'brackets inside strings do not end it');
  assert.strictEqual(api.sliceJson('x = {"a":', 4), null, 'never closes');

  // ---------- the picker's data block ----------
  const tw = api.readTwister(page([TWISTER]));
  assert.deepStrictEqual(tw.names, ['Colour', 'Size']);
  assert.deepStrictEqual(Object.keys(tw.values), ['B0BLACK001', 'B0BLACK002', 'B0WHITE001'], 'only real ASINs');
  assert.deepStrictEqual(tw.values.B0WHITE001, ['White', 'S']);
  assert.strictEqual(api.readTwister(page(['nothing here'])), null);

  // ---------- the same idea with the older index form (asinVariationValues + variationValues) ----------
  const OLD = 'var d = ' + JSON.stringify({ dimensions: ['color_name', 'size_name'], variationValues: { color_name: ['Red', 'Blue'], size_name: ['One Size'] }, asinVariationValues: { B0RED00001: { color_name: '0', size_name: '0' }, B0BLUE0001: { color_name: '1', size_name: '0' } }, variationDisplayLabels: { color_name: 'Color', size_name: 'Size' } });
  const old = api.readTwister(page([OLD]));
  assert.deepStrictEqual(old.names, ['Color', 'Size']);
  assert.deepStrictEqual(old.values, { B0RED00001: ['Red', 'One Size'], B0BLUE0001: ['Blue', 'One Size'] });

  // ---------- the gallery ----------
  assert.deepStrictEqual(api.galleryFromScripts(['no images here', GALLERY]), [
    'https://m.media-amazon.com/images/I/AAA111.jpg',
    'https://m.media-amazon.com/images/I/BBB222.jpg',
    'https://m.media-amazon.com/images/I/CCC333.jpg',
  ], 'full size, the biggest of "main" when there is no hiRes, videos left out');

  // ---------- variants of the open page ----------
  ctx.document = page([TWISTER], { lists: { '#twisterContainer li, [id^="variation_"] li, #twister li, [id^="inline-twister"] li': [
    el({ attrs: { 'data-asin': 'B0BLACK001' }, kids: { img: el({ attrs: { src: 'https://m.media-amazon.com/images/I/SWB._SS36_.jpg' } }) } }),
    el({ attrs: { 'data-defaultasin': 'B0WHITE001' }, kids: { img: el({ attrs: { src: 'https://m.media-amazon.com/images/I/SWW._SS36_.jpg' } }) } }),
  ], '[id^="variation_"]': [] } });
  const quick = api.collectVariantsQuick();
  assert.strictEqual(quick.length, 3);
  assert.deepStrictEqual(quick.map((v) => v.label), ['Black / S', 'Black / M', 'White / S']);
  assert.deepStrictEqual(quick[0].dimensions, [{ name: 'Colour', value: 'Black' }, { name: 'Size', value: 'S' }]);
  assert.strictEqual(quick[0].isCurrentProduct, true);
  assert.strictEqual(quick[0].image, 'https://m.media-amazon.com/images/I/SWB.jpg', 'the swatch picture, full size');
  assert.strictEqual(quick[2].image, 'https://m.media-amazon.com/images/I/SWW.jpg');
  assert.strictEqual(quick[1].image, null);

  // ---------- each variant's own page ----------
  const pageOf = (title, price, scripts) => page(scripts, { kids: { '#productTitle': el({ textContent: title }), '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, .a-price .a-offscreen': el({ textContent: price }), '#availability span, #availability': el({ textContent: 'In Stock' }) } });
  variantPages = {
    B0BLACK002: pageOf('Acme Jacket Black M', '$31.50', [GALLERY]),
    B0WHITE001: pageOf('Acme Jacket', '$29.99', [GALLERY]),   // the same title as the product: it gets the variant's name added
  };
  ctx.DOMParser = function () { this.parseFromString = (html) => variantPages[html]; };
  vm.runInContext('this.DOMParser = DOMParser', ctx);
  const product = { title: 'Acme Jacket', images: ['https://m.media-amazon.com/images/I/AAA111.jpg', 'https://m.media-amazon.com/images/I/BBB222.jpg'], price: 29.99, availability: 'In Stock', variants: quick };
  const progress = [];
  await api.enrichVariants(product, (m) => progress.push(m));
  const [black1, black2, white1] = product.variants;
  assert.strictEqual(fetches.length, 2, 'the open page is not fetched again');
  assert.deepStrictEqual(plain(black1.images), product.images, 'the open product keeps the gallery already read');
  assert.strictEqual(black1.title, 'Acme Jacket - Black / S', 'no own title: product title + what makes it different');
  assert.strictEqual(black2.title, 'Acme Jacket Black M', 'the variant page\'s own title');
  assert.strictEqual(black2.price, 31.5);
  assert.strictEqual(black2.images.length, 3);
  assert.strictEqual(black2.image, 'https://m.media-amazon.com/images/I/AAA111.jpg');
  assert.strictEqual(white1.title, 'Acme Jacket - White / S', 'a variant page with the very same title still gets a title of its own');
  assert.strictEqual(white1.price, 29.99);
  assert.deepStrictEqual(progress, ['Reading variants 1/2…', 'Reading variants 2/2…']);
  assert.ok(product.variants.every((v) => !('pageTitle' in v)));

  // ---------- a page that fails, and one that asks for a captcha: the variant keeps what the picker told us ----------
  variantPages = { B0BLACK002: 'FAIL', B0WHITE001: 'CAPTCHA' };
  fetches.length = 0;
  const p2 = { title: 'Acme Jacket', images: ['https://m.media-amazon.com/images/I/AAA111.jpg'], price: 29.99, variants: api.collectVariantsQuick() };
  await api.enrichVariants(p2);
  assert.strictEqual(p2.variants[2].image, 'https://m.media-amazon.com/images/I/SWW.jpg', 'the swatch picture survives');
  assert.strictEqual(p2.variants[2].title, 'Acme Jacket - White / S');
  assert.deepStrictEqual(plain(p2.variants[2].images), []);

  console.log('extension variants tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
