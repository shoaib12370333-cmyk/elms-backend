// Regression: when only sellPrice is saved (the Drafts card's quick inline-price save,
// PUT /api/list-on-ebay/:id, sends sellPrice alone - no markupPercent), the stored markup%
// must be re-derived from the new price against the listing's Amazon cost, or it goes stale
// and later displays a markup the seller never actually set.
const assert = require('assert');
const Module = require('module');

const stored = { _id: 'l1', amazonPrice: 100 };
let savedUpdate = null;

const fakes = {
  './schemas/Listing': {
    findOne: (q) => ({ select: () => ({ lean: async () => (q._id === 'l1' ? stored : null) }) }),
    findOneAndUpdate: async (_q, update) => { savedUpdate = update; return { toObject: () => ({ _id: 'l1', ...update }) }; },
  },
  './schemas/Import': {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /listingsModel/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { updateListing } = require('../models/listingsModel');
Module._load = origLoad;

(async () => {
  // sellPrice alone -> markup derived from amazonPrice=100
  await updateListing('u1', 'l1', { sellPrice: 110 });
  assert.strictEqual(savedUpdate.markupPercent, 10, '$110 sell on $100 cost is a 10% markup');

  savedUpdate = null;
  await updateListing('u1', 'l1', { sellPrice: 90 });
  assert.strictEqual(savedUpdate.markupPercent, -10, 'selling below cost is a negative markup');

  // an explicit markupPercent is never overridden by the derived one
  savedUpdate = null;
  await updateListing('u1', 'l1', { sellPrice: 110, markupPercent: 25 });
  assert.strictEqual(savedUpdate.markupPercent, 25);

  // no known Amazon cost -> markupPercent is simply left out, no crash
  savedUpdate = null;
  await updateListing('u1', 'no-such-listing', { sellPrice: 110 });
  assert.strictEqual(savedUpdate.markupPercent, undefined);

  console.log('update-listing markup tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
