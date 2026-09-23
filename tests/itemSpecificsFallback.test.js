// Required item specifics nobody filled: when "Does not apply" is not allowed, the product's own text is used
// (an allowed value it names, a number from its specifications) before the publish is stopped.
const assert = require('assert');
const taxPath = require.resolve('../services/ebayTaxonomyService');
require(taxPath);
let defs = [];
require.cache[taxPath].exports.getItemAspectsForCategory = async () => ({ aspects: defs });
const { prepareAspects } = require('../services/publishPreflightService');

const def = (o) => ({ required: true, cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: [], ...o });

(async () => {
  const product = {
    title: 'Genuine Leather Bifold Wallet for Men - Black, 12-Pack',
    description: 'Slim wallet with RFID blocking.',
    bulletPoints: ['Made of full grain leather'],
    specifications: [{ name: 'Item Weight', value: '3.2 ounces' }],
  };

  // no "Does not apply" on the list -> the colour and the material named in the text are used
  defs = [
    def({ name: 'Color', values: ['Brown', 'Black', 'Blue'] }),
    def({ name: 'Material', values: ['Leather', 'Canvas', 'Nylon'] }),
    def({ name: 'Number of Pieces', mode: 'FREE_TEXT', dataType: 'NUMBER', values: [] }),
    def({ name: 'Item Weight', mode: 'FREE_TEXT', dataType: 'NUMBER', values: [] }),
  ];
  let out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product });
  assert.deepStrictEqual(out.aspects, { Color: ['Black'], Material: ['Leather'], 'Number of Pieces': ['12'], 'Item Weight': ['3.2 ounces'] });

  // "Does not apply" is still preferred when it is allowed (behaviour unchanged)
  defs = [def({ name: 'Pattern', values: ['Plain', 'Does not apply'] })];
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { title: 'x' } });
  assert.deepStrictEqual(out.aspects, { Pattern: ['Does not apply'] });

  // a partly matching value is reduced to the allowed value it names
  defs = [def({ name: 'Colour', required: false, values: ['Black', 'Silver'] })];
  out = await prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { specifications: [{ name: 'Colour', value: 'Black/Silver' }] } });
  assert.deepStrictEqual(out.aspects, { Colour: ['Black'] });

  // vague allowed values are never guessed from text, and the error tells what is accepted
  defs = [def({ name: 'Type', values: ['Other', 'Wallet Case', 'Money Clip'] })];
  await assert.rejects(
    () => prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { title: 'Some other thing', specifications: [] } }),
    /Type \(Other \/ Wallet Case \/ Money Clip\)/
  );
  // a number aspect with nothing to read is reported as needing a number
  defs = [def({ name: 'Capacity', mode: 'FREE_TEXT', dataType: 'NUMBER' })];
  await assert.rejects(() => prepareAspects({ categoryId: '1', marketplaceId: 'EBAY_US', product: { title: 'x', specifications: [] } }), /Capacity \(a number\)/);
  console.log('item specifics fallback tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
