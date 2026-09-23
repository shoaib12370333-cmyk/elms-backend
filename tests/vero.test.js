// VeRO word detection and removal: whole-word matches only, tolerant of case / hyphens / accents,
// and the tidy-up leaves clean text behind.
const assert = require('assert');
const { getVeroPattern, findVeroTerms, stripVeroTerms, scanListing, cleanSpecificsAndAspects } = require('../services/veroService');

// whole words only
assert.deepStrictEqual(findVeroTerms('Nike Air Max running shoes'), ['nike', 'air max']);
assert.deepStrictEqual(findVeroTerms('a nikey knife and snike'), [], 'no match inside other words');
assert.deepStrictEqual(findVeroTerms('NIKE'), ['nike']);
// separators and possessives
assert.deepStrictEqual(findVeroTerms('Spider-Man, Spiderman and Spider Man toys'), ['spider-man', 'spiderman', 'spider man']);
assert.deepStrictEqual(findVeroTerms("Levi's jeans"), ["levi's"]);
assert.deepStrictEqual(findVeroTerms('Nike’s shoes'), ['nike']);
// accents
assert.deepStrictEqual(findVeroTerms('Pokémon cards'), ['pokémon'.normalize('NFD').replace(/[̀-ͯ]/g, '')]);
// the longest term wins
assert.deepStrictEqual(findVeroTerms('Polo Ralph Lauren shirt'), ['polo ralph lauren']);
// claim words
assert.ok(findVeroTerms('Replica watch, inspired by Rolex').includes('replica'));
// ordinary words that are also brands are not flagged
assert.deepStrictEqual(findVeroTerms('Apple pie, coach seat, jordan almonds, supreme quality, 5 hp motor, 3m cable'), []);

// removal keeps the rest readable
assert.strictEqual(stripVeroTerms('Nike Running Shoes for Men'), 'Running Shoes for Men');
assert.strictEqual(stripVeroTerms('Running Shoes - Nike'), 'Running Shoes');
assert.strictEqual(stripVeroTerms('Case (for iPhone) with stand'), 'Case with stand');
assert.strictEqual(stripVeroTerms('Line one Nike\nLine two, Adidas, ok'), 'Line one\nLine two, ok');
assert.strictEqual(stripVeroTerms('Café table Disney style'), 'Café table style', 'accents elsewhere are kept');
assert.strictEqual(stripVeroTerms('nothing here'), 'nothing here');

// scanning a whole listing says where each word is
const scan = scanListing({
  title: 'Adidas cap', description: 'Soft cotton. Marvel design.', bulletPoints: ['Fits all', 'Official Disney look'],
  specifications: [{ name: 'Brand', value: 'Nike' }], aspects: { Brand: ['Puma'], Color: ['Black'] }, brand: 'Gucci',
});
assert.deepStrictEqual(Object.keys(scan.fields).sort(), ['aspects', 'brand', 'bulletPoints', 'description', 'specifications', 'title']);
assert.deepStrictEqual(scan.terms.sort(), ['adidas', 'disney', 'gucci', 'marvel', 'nike', 'puma']);
assert.deepStrictEqual(scanListing({ title: 'Plain wooden table' }).terms, []);

// specifics / aspects: brand -> Unbranded, other values cut, empty ones dropped
const cleaned = cleanSpecificsAndAspects({
  specifications: [{ name: 'Brand', value: 'Nike' }, { name: 'Manufacturer', value: 'Nike Inc' }, { name: 'Color', value: 'Black' }, { name: 'Theme', value: 'Disney' }, { name: 'Series', value: 'Marvel Avengers' }],
  aspects: { Brand: ['Nike'], Character: ['Marvel'], Color: ['Black'], Features: ['Adidas style', 'Light'] },
});
assert.deepStrictEqual(cleaned.specifications, [{ name: 'Brand', value: 'Unbranded' }, { name: 'Color', value: 'Black' }]);
assert.deepStrictEqual(cleaned.aspects, { Brand: ['Unbranded'], Color: ['Black'], Features: ['style', 'Light'] });
assert.ok(cleaned.removed.includes('nike') && cleaned.removed.includes('marvel'));

// the pattern is exported for the browser and works standalone on accent-folded text
const { source, flags } = getVeroPattern();
assert.ok(new RegExp(source, flags).test('buy nike now'));
// a custom word from the environment is picked up
process.env.VERO_EXTRA_WORDS = 'acmecorp, widget king';
assert.deepStrictEqual(findVeroTerms('The Widget King by AcmeCorp'), ['widget king', 'acmecorp']);
console.log('vero tests passed');
