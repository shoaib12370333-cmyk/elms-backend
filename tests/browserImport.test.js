// What the extension sends is cleaned before it is saved: every picture, specification and - new - every variant with its
// own title, pictures, price and dimensions. Nothing is invented and nothing unsafe is kept.
const assert = require('assert');
const { cleanProduct } = require('../routes/browserImport');

const product = cleanProduct({
  asin: 'B0BLACK001',
  title: 'Acme Jacket Keyboard shortcut shift + alt + t',
  images: ['https://m.media-amazon.com/images/I/A.jpg', 'https://m.media-amazon.com/images/I/A.jpg', 'javascript:alert(1)', 'https://m.media-amazon.com/images/I/B.jpg'],
  specifications: [{ name: 'Material', value: 'Polyester' }, { name: '', value: 'no name' }, { name: 'Empty', value: '' }],
  variants: [
    { asin: 'b0black001', title: 'Acme Jacket - Black / S', label: 'Black / S', image: 'https://m.media-amazon.com/images/I/A.jpg', images: ['https://m.media-amazon.com/images/I/A.jpg', 'https://m.media-amazon.com/images/I/B.jpg', 'http://x/y.jpg', 'not a url'], price: '29.99', availability: 'In Stock', isCurrentProduct: true, dimensions: [{ name: 'Colour', value: 'Black' }, { name: 'Size', value: 'S' }, { name: 'Bad', value: '' }] },
    { asin: 'B0BLACK002', label: 'Black / M', image: 'https://m.media-amazon.com/images/I/C.jpg', images: [], price: 'abc', dimensions: [{ name: 'Colour', value: 'Black' }, { name: 'Size', value: 'M' }] },
    { asin: 'B0BLACK001', title: 'a repeat of the first: dropped' },
    { asin: 'short', title: 'not an asin: dropped' },
    { title: 'no asin: dropped' },
    null,
  ],
}, 'https://www.amazon.com/dp/B0BLACK001');

assert.strictEqual(product.title, 'Acme Jacket', 'the page\'s accessibility text is removed from the title');
assert.deepStrictEqual(product.images, ['https://m.media-amazon.com/images/I/A.jpg', 'https://m.media-amazon.com/images/I/B.jpg'], 'real, unique, https-or-http links only');
assert.deepStrictEqual(product.specifications, [{ name: 'Material', value: 'Polyester' }]);

assert.strictEqual(product.variants.length, 2, 'a repeat, a bad ASIN, no ASIN and null are all dropped');
const [first, second] = product.variants;
assert.strictEqual(first.asin, 'B0BLACK001');
assert.strictEqual(first.title, 'Acme Jacket - Black / S');
assert.strictEqual(first.label, 'Black / S');
assert.strictEqual(first.price, 29.99);
assert.strictEqual(first.isCurrentProduct, true);
assert.deepStrictEqual(first.images, ['https://m.media-amazon.com/images/I/A.jpg', 'https://m.media-amazon.com/images/I/B.jpg', 'http://x/y.jpg'].filter((u) => /^https?:\/\//.test(u)));
assert.deepStrictEqual(first.dimensions, [{ name: 'Colour', value: 'Black' }, { name: 'Size', value: 'S' }], 'a dimension without a value is dropped');
assert.strictEqual(second.title, 'Black / M', 'no title: the label stands in for it');
assert.strictEqual(second.price, null, 'a price that is not a number is not kept');
assert.deepStrictEqual(second.images, ['https://m.media-amazon.com/images/I/C.jpg'], 'no gallery: its one picture');
assert.deepStrictEqual(product.variantDimensions, ['Colour', 'Size']);

// nothing sent -> nothing invented
const plain = cleanProduct({ asin: 'B0PLAIN001', title: 'Plain thing' }, 'https://www.amazon.com/dp/B0PLAIN001');
assert.deepStrictEqual(plain.variants, []);
assert.deepStrictEqual(plain.variantDimensions, []);

// a runaway page cannot stuff the database
const many = cleanProduct({ asin: 'B0MANY0001', title: 'Many', variants: Array.from({ length: 120 }, (_, i) => ({ asin: 'B0' + String(i).padStart(8, '0'), label: 'v' + i, images: Array.from({ length: 40 }, (_, k) => `https://m.media-amazon.com/images/I/${i}_${k}.jpg`) })) }, 'https://www.amazon.com/dp/B0MANY0001');
assert.strictEqual(many.variants.length, 50);
assert.ok(many.variants.every((v) => v.images.length <= 12));

console.log('browser import tests passed');

// ---- the variants travel with the listing rows, compactly ----
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './schemas/Listing' && parent && /listingsModel\.js/.test(parent.filename)) return {};
  return origLoad.apply(this, arguments);
};
const { withImportFallback, compactVariants } = require('../models/listingsModel');
Module._load = origLoad;
const row = withImportFallback({ description: 'd', bullet_points: ['b'], specifications: [{ name: 'a', value: 'b' }], ebay_aspects: { x: ['y'] } }, { importId: { product: { brand: 'Acme', variants: product.variants } } });
assert.strictEqual(row.variants_count, 2);
assert.deepStrictEqual(Object.keys(row.variants[0]).sort(), ['asin', 'dimensions', 'image', 'isCurrentProduct', 'label', 'price', 'title'], 'only what the list needs: the long picture lists stay on the import');
assert.strictEqual(row.variants[1].image, 'https://m.media-amazon.com/images/I/C.jpg');
assert.deepStrictEqual(withImportFallback({}, { importId: { product: { brand: 'x' } } }).variants, [], 'a product with no variants has an empty list, not a made-up one');
assert.deepStrictEqual(compactVariants(null), []);
console.log('listing variants tests passed');
