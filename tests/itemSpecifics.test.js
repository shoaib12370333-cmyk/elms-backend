// Item specifics: values past eBay's first 100 choices stay valid, Amazon's invisible marks and useless
// facts never reach eBay, "Does not apply" is not sent for number/date aspects, over-long names are skipped.
const assert = require('assert');
const taxPath = require.resolve('../services/ebayTaxonomyService');
require(taxPath);
let defs = [];
require.cache[taxPath].exports.getItemAspectsForCategory = async () => ({ aspects: defs });
const { prepareAspects } = require('../services/publishPreflightService');
const { buildAspects } = require('../services/ebayListingService');

const withAll = (def, all) => Object.defineProperty(def, 'allValues', { value: all, enumerable: false });

(async () => {
  // A colour that is #150 on eBay's list (the editor only gets the first 100) is still accepted.
  const all = Array.from({ length: 200 }, (_, i) => 'Colour ' + i);
  defs = [withAll({ name: 'Colour', required: false, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: all.slice(0, 100) }, all)];
  let out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { ebayAspects: { colour: ['colour 150'] } } });
  assert.deepStrictEqual(out.aspects, { Colour: ['Colour 150'] });

  // Invisible left-to-right mark from Amazon does not break the match.
  defs = [{ name: 'Colour', required: false, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: ['Black', 'Blue'] }];
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { specifications: [{ name: '‎Colour', value: '‎Black' }] } });
  assert.deepStrictEqual(out.aspects, { Colour: ['Black'] });

  // A required NUMBER aspect with no value is reported, not filled with "Does not apply".
  defs = [{ name: 'Number of Pieces', required: true, cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'NUMBER', values: [] }];
  await assert.rejects(() => prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: {} }), /Number of Pieces/);
  // ... while a text aspect still gets it.
  defs = [{ name: 'Pattern', required: true, cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'STRING', values: [] }];
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: {} });
  assert.deepStrictEqual(out.aspects, { Pattern: ['Does not apply'] });

  // A free-text aspect only SUGGESTS values: Brand with a long list that lacks "Unbranded" still gets it when empty ...
  defs = [{ name: 'Brand', required: true, cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'STRING', values: ['Nike', 'Adidas'] }];
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: {} });
  assert.deepStrictEqual(out.aspects, { Brand: ['Unbranded'] });
  // ... and the seller's own brand, which is not on the list, is kept.
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { ebayAspects: { Brand: ['Acme'] } } });
  assert.deepStrictEqual(out.aspects, { Brand: ['Acme'] });
  // a "choose from" aspect whose list has no "not applicable" value is still reported
  defs = [{ name: 'Department', required: true, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: ['Men', 'Women'] }];
  await assert.rejects(() => prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { title: 'Some thing' } }), /Department/);

  // buildAspects cleans what it sends.
  const a = buildAspects({
    brand: 'Acme',
    specifications: [
      { name: 'ASIN', value: 'B000000001' },
      { name: 'Best Sellers Rank', value: '#1' },
      { name: 'x'.repeat(66), value: 'too long a name' },
      { name: '‎Material', value: '‎Steel <b>bold</b>' },
    ],
  });
  assert.deepStrictEqual(a, { Brand: ['Acme'], Material: ['Steel bold'] });

  console.log('item specifics tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
