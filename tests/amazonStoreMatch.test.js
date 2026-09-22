// Checks assertAmazonMatchesStore: the guard that stops a UK store from importing a .com
// link (and vice versa), while never blocking a marketplace that has no single matching
// Amazon site.
const assert = require('assert');
const { assertAmazonMatchesStore } = require('../services/validationService');

function throws(fn, pattern) {
  try { fn(); return false; } catch (e) { return pattern.test(e.message) && e.statusCode === 400; }
}

// mismatched domain for a mapped marketplace -> rejected
assert.ok(throws(() => assertAmazonMatchesStore('https://www.amazon.com/dp/B0000001', 'EBAY_GB'), /amazon\.co\.uk/));
assert.ok(throws(() => assertAmazonMatchesStore('https://www.amazon.co.uk/dp/B0000001', 'EBAY_US'), /amazon\.com/));
assert.ok(throws(() => assertAmazonMatchesStore('https://www.amazon.de/dp/B0000001', 'EBAY_FR'), /amazon\.fr/));

// matching domain -> passes silently for every mapped marketplace
for (const [marketplaceId, url] of [
  ['EBAY_US', 'https://www.amazon.com/dp/B0000001'],
  ['EBAY_GB', 'https://www.amazon.co.uk/dp/B0000001'],
  ['EBAY_CA', 'https://www.amazon.ca/dp/B0000001'],
  ['EBAY_DE', 'https://www.amazon.de/dp/B0000001'],
  ['EBAY_FR', 'https://www.amazon.fr/dp/B0000001'],
  ['EBAY_IT', 'https://www.amazon.it/dp/B0000001'],
  ['EBAY_ES', 'https://www.amazon.es/dp/B0000001'],
  ['EBAY_AU', 'https://www.amazon.com.au/dp/B0000001'],
  ['EBAY_NL', 'https://www.amazon.nl/dp/B0000001'],
]) {
  assertAmazonMatchesStore(url, marketplaceId); // must not throw
}

// a marketplace with no single matching Amazon site never blocks anything
assertAmazonMatchesStore('https://www.amazon.com/dp/B0000001', 'EBAY_AT');
assertAmazonMatchesStore('https://www.amazon.de/dp/B0000001', 'EBAY_CH');
assertAmazonMatchesStore('https://www.amazon.co.uk/dp/B0000001', 'EBAY_IE');

// no active store selected -> never blocks
assertAmazonMatchesStore('https://www.amazon.com/dp/B0000001', null);
assertAmazonMatchesStore('https://www.amazon.co.uk/dp/B0000001', undefined);

console.log('amazon store-match tests passed');
