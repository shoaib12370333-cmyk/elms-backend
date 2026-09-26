// One product per link: only the product whose link was pasted is kept (every source marks it as isCurrentProduct, and it has the
// product's own ASIN). The other colours / sizes are not saved, and drafts imported before show only the product itself too.
const assert = require('assert');
const { ownVariantOnly, onlyThisProduct } = require('../services/productVariants');
const { compactVariants } = require('../models/listingsModel');

const list = [
  { asin: 'B000000001', title: 'Blue', isCurrentProduct: false },
  { asin: 'B000000002', title: 'Red', isCurrentProduct: true },
  { asin: 'B000000003', title: 'Green', isCurrentProduct: false },
];
assert.deepStrictEqual(ownVariantOnly(list, 'B000000002').map((v) => v.title), ['Red'], 'the product of the link');
assert.deepStrictEqual(ownVariantOnly([{ asin: 'b000000009', title: 'Own' }, { asin: 'B000000008', title: 'Other' }], 'B000000009').map((v) => v.title), ['Own'], 'found by its ASIN, any case, when the flag is missing');
assert.deepStrictEqual(ownVariantOnly([{ asin: 'B000000001' }, { asin: 'B000000003' }], 'B000000002'), [], 'a list without the product itself keeps nothing');
assert.deepStrictEqual(ownVariantOnly(undefined, 'B0'), []); assert.deepStrictEqual(ownVariantOnly('x', 'B0'), []); assert.deepStrictEqual(ownVariantOnly([null, {}], ''), []);

const product = { asin: 'B000000002', title: 'Red kettle', variants: list, variantDimensions: ['Colour'] };
assert.strictEqual(onlyThisProduct(product), product, 'the same object comes back');
assert.deepStrictEqual(product.variants.map((v) => v.asin), ['B000000002']); assert.deepStrictEqual(product.variantDimensions, []);
assert.strictEqual(onlyThisProduct(null), null); assert.deepStrictEqual(onlyThisProduct({ asin: 'B1' }).variants, []);

// what a listing row carries (drafts made before too): at most the product itself
assert.strictEqual(compactVariants(ownVariantOnly(list, 'B000000002')).length, 1);
assert.strictEqual(compactVariants(ownVariantOnly(list, 'B000000002'))[0].isCurrentProduct, true);

console.log('product variants tests passed');
