const assert = require('assert');
const { buildSettingsUpdate } = require('../models/listingsModel');
const { cleanPostalCode, normalizeCountry } = require('../services/postalGeneratorService');

// tags: trimmed, de-duplicated, capped
assert.deepStrictEqual(buildSettingsUpdate({ tags: ' a, b ,a,, c' }).tags, ['a', 'b', 'c']);
// policies: valid ids kept, junk ignored, null clears
assert.strictEqual(buildSettingsUpdate({ paymentPolicyId: '6123456000' }).paymentPolicyId, '6123456000');
assert.ok(!('paymentPolicyId' in buildSettingsUpdate({ paymentPolicyId: 'bad id; drop' })));
assert.strictEqual(buildSettingsUpdate({ returnPolicyId: '' }).returnPolicyId, null);
// location: UK is normalised to GB, postal code upper-cased and validated
const loc = buildSettingsUpdate({ countryLocation: 'uk', postalCode: 'sw1a 2dx', locationCity: 'London' });
assert.strictEqual(loc.countryLocation, 'GB');
assert.strictEqual(loc.postalCode, 'SW1A 2DX');
assert.ok(!('postalCode' in buildSettingsUpdate({ postalCode: '<script>' })));
// monitoring defaults stay on unless explicitly false
assert.strictEqual(buildSettingsUpdate({ stockMonitoring: false }).stockMonitoring, false);
assert.strictEqual(buildSettingsUpdate({ priceMonitoring: 'yes' }).priceMonitoring, true);

// postal code formats
assert.strictEqual(cleanPostalCode('US', '10001-1234'), '10001');
assert.strictEqual(cleanPostalCode('US', '10000'), null);
assert.strictEqual(cleanPostalCode('GB', 'sw1a2dx'), 'SW1A 2DX');
assert.strictEqual(cleanPostalCode('CA', 'm5h3m9'), 'M5H 3M9');
assert.strictEqual(cleanPostalCode('NL', '1012kb'), '1012 KB');
assert.strictEqual(cleanPostalCode('DE', '1011'), null);
assert.strictEqual(normalizeCountry('uk'), 'GB');
assert.throws(() => normalizeCountry('ZZ'));
console.log('listing settings + postal code tests passed');
