// models/schemas/AiUsage.js's `kind` enum must include every kind actually written: descriptionBeautifyService.js and
// listOnEbay.js write 'beautify', supportAssistantService.js writes 'support' - both used to be missing from the
// enum, so every one of those writes failed Mongoose validation and was silently swallowed by the .catch(()=>{}) at
// each call site, making that feature's AI usage/spend invisible in the Admin Panel. Pure schema validation, no
// database needed (Document#validateSync does not require a connection).
const assert = require('assert');
const AiUsage = require('../models/schemas/AiUsage');

const ALL_KINDS = ['title', 'description', 'aspects', 'reply', 'vero', 'category', 'beautify', 'support'];

(async () => {
  for (const kind of ALL_KINDS) {
    const doc = new AiUsage({ userId: new (require('mongoose').Types.ObjectId)(), kind, credits: 0 });
    const err = doc.validateSync();
    assert.strictEqual(err, undefined, `kind "${kind}" should be a valid enum value, got: ${err && err.message}`);
  }
  const bad = new AiUsage({ userId: new (require('mongoose').Types.ObjectId)(), kind: 'not-a-real-kind', credits: 0 });
  assert.ok(bad.validateSync(), 'an unknown kind is still rejected - the enum is not just wide open');

  console.log('ai usage kinds tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
