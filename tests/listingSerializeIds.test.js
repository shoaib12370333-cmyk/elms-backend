// A listing loaded with .populate('importId').populate('ebayAccountId') has whole documents in those
// fields. serialize() used to call toString() on them, giving "[object Object]" - the UI then sent
// that back as accountId and saving a draft failed with "That does not look like a valid eBay account".
const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './schemas/Listing' && parent && /listingsModel\.js/.test(parent.filename)) return {};
  return origLoad.apply(this, arguments);
};
const { serialize } = require('../models/listingsModel');
Module._load = origLoad;

const oid = (hex) => ({ _id: hex, toString: () => hex });
const accountHex = '64b7f0c2a1b2c3d4e5f60718';
const importHex = '64b7f0c2a1b2c3d4e5f60719';

// Populated: the field holds the full document (its toObject() is a plain object with _id).
const populated = { toObject: () => ({ _id: oid('l1'), ebayAccountId: { _id: oid(accountHex), ebayUserId: 'seller' }, importId: { _id: oid(importHex), amazonUrl: 'x' } }) };
let s = serialize(populated);
assert.strictEqual(s.ebay_account_id, accountHex);
assert.strictEqual(s.import_id, importHex);

// Not populated: the field is the bare ObjectId.
s = serialize({ toObject: () => ({ _id: oid('l2'), ebayAccountId: oid(accountHex), importId: oid(importHex) }) });
assert.strictEqual(s.ebay_account_id, accountHex);
assert.strictEqual(s.import_id, importHex);

// Unassigned.
s = serialize({ toObject: () => ({ _id: oid('l3'), ebayAccountId: null, importId: null }) });
assert.strictEqual(s.ebay_account_id, null);
assert.strictEqual(s.import_id, null);

console.log('listing serialize ids tests passed');
