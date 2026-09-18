const assert = require('assert');
const { normalizeAsinSku, requireAsinSku } = require('../services/skuService');

assert.strictEqual(normalizeAsinSku('B0GZWQ8JML'), 'B0GZWQ8JML');
assert.strictEqual(normalizeAsinSku(' amz-b0gzwq8jml '), 'B0GZWQ8JML');
assert.strictEqual(normalizeAsinSku(null), null);
assert.throws(() => requireAsinSku(null), /Amazon ASIN is required/);
assert.throws(() => requireAsinSku('AMZ-BAD'), /Invalid Amazon ASIN/);
assert.strictEqual(requireAsinSku('AMZ-B0GZWQ8JML'), 'B0GZWQ8JML');
assert.strictEqual(requireAsinSku('b0gzwq8jml'), 'B0GZWQ8JML');

console.log('SKU policy tests: PASS');
