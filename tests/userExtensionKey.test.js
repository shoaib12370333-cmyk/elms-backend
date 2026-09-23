// Regression test: signing up a second user failed with
// "E11000 duplicate key ... extensionKeyHash_1 dup key: { extensionKeyHash: null }" because the
// field defaulted to null under a unique index. New users must have the field missing, and the
// index must be partial (only real string hashes are unique).
const assert = require('node:assert/strict');
const User = require('../models/schemas/User');

const a = new User({ username: 'a', email: 'a@x.com' }).toObject();
const b = new User({ username: 'b', email: 'b@x.com' }).toObject();
assert.ok(!('extensionKeyHash' in a) || a.extensionKeyHash === undefined, 'no stored null hash');
assert.ok(!('extensionKeyHash' in b) || b.extensionKeyHash === undefined, 'no stored null hash');

const idx = User.schema.indexes().find(([spec]) => spec.extensionKeyHash === 1);
assert.ok(idx, 'extensionKeyHash index declared');
assert.equal(idx[1].unique, true);
assert.deepEqual(idx[1].partialFilterExpression, { extensionKeyHash: { $type: 'string' } });

console.log('user extension key tests passed');
