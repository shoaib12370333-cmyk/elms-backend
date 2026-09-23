// eBay's get_category_suggestions matches best on a short, buyer-style phrase -
// feeding it a full raw Amazon title (with pack-count/color/size call-outs and
// marketing copy) reliably returns an irrelevant top category. This regression
// test locks in that suggestCategories now cleans/trims the query first.
const assert = require('node:assert/strict');
const { buildCategoryQuery } = require('../services/ebayTaxonomyService');

const cases = [
  {
    title: "Under Armour Men's Tech 2.0 Short Sleeve T-Shirt (Pack of 3, Black/Grey/Navy), Small",
    expectNotIncludes: ['Pack', 'Black/Grey/Navy'],
  },
  {
    title: 'Anker USB C Charger, 20W PIQ 3.0 Fast Charger [Fast Charge for iPhone 14/13/12, Compatible with iPad]',
    expectNotIncludes: ['Fast Charge for iPhone 14/13/12', 'Compatible with iPad'],
  },
];

for (const { title, expectNotIncludes } of cases) {
  const cleaned = buildCategoryQuery(title);
  for (const bad of expectNotIncludes) {
    assert.ok(!cleaned.includes(bad), `expected "${cleaned}" to drop bracketed text "${bad}"`);
  }
}

// Caps to the first 10 words so a long marketing title doesn't dilute the match.
const longTitle = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
assert.strictEqual(buildCategoryQuery(longTitle).split(' ').length, 10);

// Empty/whitespace-only input degrades gracefully instead of throwing.
assert.strictEqual(buildCategoryQuery(''), '');
assert.strictEqual(buildCategoryQuery('   '), '');

console.log('category query tests passed');
