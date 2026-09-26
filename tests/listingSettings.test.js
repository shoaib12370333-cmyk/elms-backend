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
// the private note: line breaks kept, trimmed, cut at 2000 characters, empty (or null) clears it, not sent = not touched
assert.strictEqual(buildSettingsUpdate({ note: '  Buy from seller A\r\nsecond line  ' }).note, 'Buy from seller A\nsecond line');
assert.strictEqual(buildSettingsUpdate({ note: 'x'.repeat(3000) }).note.length, 2000);
assert.strictEqual(buildSettingsUpdate({ note: '' }).note, '');
assert.strictEqual(buildSettingsUpdate({ note: null }).note, '');
assert.ok(!('note' in buildSettingsUpdate({ tags: 'a' })));
// ... and it is never part of what goes to eBay
{
  const { buildListingBodies } = require('../services/ebayListingService');
  const bodies = buildListingBodies({ product: { asin: 'B012345678', title: 'Kettle', description: 'Desc', images: ['https://img.example/1.jpg'], note: 'PRIVATE-NOTE-TEXT' }, sellPrice: 20, quantity: 1, categoryId: '9355',
    sellerSettings: { merchantLocationKey: 'l', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_GB' } });
  assert.ok(!JSON.stringify(bodies).includes('PRIVATE-NOTE-TEXT'), 'the private note is not in the eBay request');
}
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

// eBay traffic XML parsing (regression: backslashes were lost, so watchers were always 0)
{
  const assert = require('assert');
  const { pickNumber } = require('../services/ebayStatsService');
  const xml = '<Item><HitCount>120</HitCount><WatchCount> 7 </WatchCount></Item>';
  assert.strictEqual(pickNumber(xml, 'WatchCount'), 7);
  assert.strictEqual(pickNumber(xml, 'HitCount'), 120);
  assert.strictEqual(pickNumber('<Item/>', 'HitCount'), null);
  console.log('traffic parsing tests passed');
}
