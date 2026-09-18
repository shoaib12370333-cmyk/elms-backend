const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const listingService = fs.readFileSync(path.join(__dirname, '..', 'services', 'ebayListingService.js'), 'utf8');
const listingsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'listings.js'), 'utf8');
const authRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

assert.match(listingService, /X-EBAY-C-MARKETPLACE-ID/);
assert.match(listingService, /Accept-Language/);
assert.match(listingService, /Content-Language/);
assert.match(listingService, /requireAsinSku\(sku \|\| product\.asin/);
assert.match(listingService, /marketplaceId: normalizedMarketplaceId/);
assert.match(listingsRoute, /router\.get\('\/:id\/detail', requireAuth/);
assert.match(authRoute, /sendPasswordResetOtp\(\{ to: email, code \}\)/);
assert.match(authRoute, /if \(!user\) return res\.status\(200\)\.json\(generic\);/);

console.log('Final integration policy tests: PASS');
