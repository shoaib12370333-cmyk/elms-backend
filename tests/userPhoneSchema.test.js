// models/schemas/User.js + PendingSignup.js: the phone fields exist with safe defaults (an old account has none and is not "required"), and
// nothing but plain strings / a boolean can be stored in them.
const assert = require('assert');
const User = require('../models/schemas/User');
const PendingSignup = require('../models/schemas/PendingSignup');

const u = new User({ email: 'a@x.com' });
assert.deepStrictEqual([u.phone, u.phoneCountry, u.phoneDisplay, u.phoneRequired], [null, null, null, undefined], 'an account without a number: nulls, and NOT marked required (old accounts may skip)');
const withPhone = new User({ email: 'b@x.com', phone: '+923001234567', phoneCountry: 'PK', phoneDisplay: '+92 300 1234567', phoneRequired: true });
assert.strictEqual(withPhone.validateSync(), undefined);
assert.deepStrictEqual([withPhone.phone, withPhone.phoneCountry, withPhone.phoneDisplay, withPhone.phoneRequired], ['+923001234567', 'PK', '+92 300 1234567', true]);
// an object cannot be smuggled into a text field
const sneaky = new User({ email: 'c@x.com', phone: { $gt: '' } });
assert.ok(sneaky.validateSync() || typeof sneaky.phone === 'string' || sneaky.phone == null, 'a query object is not stored as a phone');

const p = new PendingSignup({ email: 'p@x.com', username: 'pp', passwordHash: 'h', tokenHash: 't', codeHash: 'c', codeExpiresAt: new Date(), lastSentAt: new Date(), expiresAt: new Date(), phone: '+923001234567', phoneCountry: 'PK', phoneDisplay: '+92 300 1234567' });
assert.strictEqual(p.validateSync(), undefined);
assert.deepStrictEqual([p.phone, p.phoneCountry, p.phoneDisplay], ['+923001234567', 'PK', '+92 300 1234567']);
const noPhone = new PendingSignup({ email: 'p@x.com', username: 'pp', passwordHash: 'h', tokenHash: 't', codeHash: 'c', codeExpiresAt: new Date(), lastSentAt: new Date(), expiresAt: new Date() });
assert.deepStrictEqual([noPhone.phone, noPhone.validateSync()], [null, undefined], 'a pending sign-up from before this existed still loads');

console.log('user phone schema tests passed');
