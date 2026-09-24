// VeRO words are the user's own list: only what they saved is flagged. Whole-word, case / hyphen / accent tolerant matching,
// and a tidy removal.
const assert = require('assert');
const { createMatcher, normalizeWord } = require('../services/veroService');

const words = ['nike', 'air max', 'spider-man', "levi's", 'ralph lauren', 'polo ralph lauren', 'pokemon', 'apple', 'ring', 'hermès', "l'oreal", 'tiffany & co', 'black+decker', 'b&o', 'adidas', 'marvel', 'disney', 'gucci', 'puma', 'replica', 'rolex'];
const vero = createMatcher(words);
const { findVeroTerms, stripVeroTerms, scanListing, cleanSpecificsAndAspects } = vero;

// only the saved words are flagged
assert.deepStrictEqual(createMatcher([]).findVeroTerms('Nike Air Max'), [], 'an empty list flags nothing');
assert.strictEqual(createMatcher([]).pattern, null);
assert.deepStrictEqual(createMatcher(['nike']).findVeroTerms('Nike and Adidas'), ['nike'], 'adidas was not saved, so it is not flagged');

// whole words only
assert.deepStrictEqual(findVeroTerms('Nike Air Max running shoes'), ['nike', 'air max']);
assert.deepStrictEqual(findVeroTerms('a nikey knife and snike'), [], 'no match inside other words');
assert.deepStrictEqual(findVeroTerms('NIKE'), ['nike']);
// separators, possessives, accents
assert.deepStrictEqual(findVeroTerms('Spider-Man, Spiderman and Spider Man toys'), ['spider-man', 'spiderman', 'spider man']);
assert.deepStrictEqual(findVeroTerms("Levi's jeans"), ["levi's"]);
assert.deepStrictEqual(findVeroTerms('Nike’s shoes'), ['nike']);
assert.deepStrictEqual(findVeroTerms('Pokémon cards'), ['pokemon']);
assert.deepStrictEqual(findVeroTerms('Cheap Hermes bag'), ['hermes'], 'the accent typed by the user does not matter');
// the longest word wins
assert.deepStrictEqual(findVeroTerms('Polo Ralph Lauren shirt'), ['polo ralph lauren']);
// symbols in words
for (const text of ['Tiffany & Co box', "L'Oréal set", 'Black+Decker drill', 'B&O speaker']) assert.strictEqual(findVeroTerms(text).length, 1, text);
// ordinary words are flagged when the user saved them
assert.deepStrictEqual(findVeroTerms('Apple pie and a diamond ring'), ['apple', 'ring']);

// removal keeps the rest readable
assert.strictEqual(stripVeroTerms('Nike Running Shoes for Men'), 'Running Shoes for Men');
assert.strictEqual(stripVeroTerms('Running Shoes - Nike'), 'Running Shoes');
assert.strictEqual(stripVeroTerms('Case (for Apple) with stand'), 'Case with stand');
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
assert.deepStrictEqual(cleaned.specifications, [{ name: 'Brand', value: 'Unbranded' }, { name: 'Color', value: 'Black' }, { name: 'Series', value: 'Avengers' }]);
assert.deepStrictEqual(cleaned.aspects, { Brand: ['Unbranded'], Color: ['Black'], Features: ['style', 'Light'] });
assert.ok(cleaned.removed.includes('nike') && cleaned.removed.includes('marvel'));

// the pattern is handed to the browser and works standalone on accent-folded text
const { source, flags } = vero.pattern;
assert.ok(new RegExp(source, flags).test('buy nike now'));
assert.ok(!new RegExp(source, flags).test('buy reebok now'));

// the same list gives the same (cached) matcher; a different list does not
assert.strictEqual(createMatcher(words), vero);
assert.notStrictEqual(createMatcher(['nike']), vero);

// what a user types becomes a storable word
assert.strictEqual(normalizeWord('  Nike  '), 'nike');
assert.strictEqual(normalizeWord('Air   MAX'), 'air max');
assert.strictEqual(normalizeWord('"Adidas",'), 'adidas');
assert.strictEqual(normalizeWord('Tiffany & Co'), 'tiffany & co');
for (const bad of ['', ' ', 'a', '--', '"', 'x'.repeat(61), null, undefined]) assert.strictEqual(normalizeWord(bad), null, String(bad));
console.log('vero tests passed');
