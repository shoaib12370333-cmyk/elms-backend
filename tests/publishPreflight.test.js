const assert = require('assert');
const taxPath = require.resolve('../services/ebayTaxonomyService');
require(taxPath);
let defs = [];
let fail = null;
require.cache[taxPath].exports.getItemAspectsForCategory = async () => { if (fail) throw fail; return { aspects: defs }; };
const { prepareAspects } = require('../services/publishPreflightService');

(async () => {
  defs = [
    { name: 'Brand', required: true, cardinality: 'SINGLE', mode: 'FREE_TEXT', values: [] },
    { name: 'MPN', required: true, cardinality: 'SINGLE', mode: 'FREE_TEXT', values: [] },
    { name: 'Colour', required: false, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', values: ['Black', 'Blue'] },
    { name: 'Type', required: true, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', values: ['Bag', 'Case'] },
  ];
  // Colour "Black/Grey" is not on eBay's list -> dropped; Type has no value and no "Does not apply" -> blocks the publish
  await assert.rejects(() => prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_GB', product: { specifications: [{ name: 'Colour', value: 'Black/Grey' }] } }), /Type/);

  const ok = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_GB', product: { brand: '', ebayAspects: { Type: ['case'], colour: ['blue'] }, specifications: [{ name: 'Colour', value: 'Green' }] } });
  assert.deepStrictEqual(ok.aspects, { Type: ['Case'], Colour: ['Blue'], Brand: ['Unbranded'], MPN: ['Does not apply'] });

  fail = Object.assign(new Error('nope'), { statusCode: 404 });
  await assert.rejects(() => prepareAspects({ categoryId: '9', marketplaceId: 'EBAY_GB', product: {} }), /does not recognise category/);
  fail = Object.assign(new Error('timeout'), { statusCode: 502 });
  assert.strictEqual((await prepareAspects({ categoryId: '9', marketplaceId: 'EBAY_GB', product: {} })).aspects, null);
  console.log('publish preflight tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
