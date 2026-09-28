// The buyer-facing tracking code: made once per order+number (re-saving the same number never makes a second one),
// registers the real number with 17TRACK but keeps working (with no live status yet) if that call fails, and the
// webhook's own lookup (by tracking number + carrier, since that's all 17TRACK ever gives back) finds it.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const docs = [];
let existsCodes = new Set();
const matches = (q) => docs.filter((d) => Object.keys(q).every((k) => String(d[k]) === String(q[k])));
// Thenable AND chainable: createOrGetForOrder does `await TrackingLink.findOne(q)` directly, while getForOrder does
// `TrackingLink.findOne(q).sort(...).lean()` - a real Mongoose Query supports both, so the stub has to as well.
const findOneChain = (found) => {
  const q = { sort: () => q, lean: async () => found, then: (res, rej) => Promise.resolve(found).then(res, rej) };
  return q;
};
const TrackingLinkStub = {
  findOne: (q) => findOneChain(matches(q).sort((a, b) => b.createdAt - a.createdAt)[0] || null),
  exists: async ({ code }) => existsCodes.has(code),
  create: async (fields) => {
    const doc = { _id: 'tl' + (docs.length + 1), createdAt: new Date(Date.now() + docs.length), ...fields };
    docs.push(doc);
    existsCodes.add(doc.code);
    return doc;
  },
  updateOne: async (filter, update) => { const d = docs.find((x) => x._id === filter._id); if (d) Object.assign(d, update.$set); return { modifiedCount: d ? 1 : 0 }; },
  updateMany: async (filter, update) => {
    let n = 0;
    for (const d of docs) {
      if (Object.keys(filter).every((k) => filter[k] === undefined || String(d[k]) === String(filter[k]))) { Object.assign(d, update.$set); n++; }
    }
    return { modifiedCount: n };
  },
};
stub('models/schemas/TrackingLink', TrackingLinkStub);

let registerBehavior = async () => ({ carrier: 100003 });
stub('services/track17Service', { registerTracking: (...a) => registerBehavior(...a), getTrackInfo: async () => null, statusFromTrackInfo: () => null });

const M = require('../models/trackingLinksModel');

(async () => {
  // ---- creating a code ----
  const link1 = await M.createOrGetForOrder('u1', 'o1', 'RR123456789CN');
  assert.match(link1.code, /^ELM\d{5}$/, 'a short, buyer-typeable code');
  assert.strictEqual(link1.carrier17, 100003, "17TRACK's own carrier code is saved");
  assert.ok(link1.registeredAt, 'registration succeeded');

  // re-saving the same order+number reuses the same code, no second 17TRACK registration or DB row
  let registerCalls = 0;
  registerBehavior = async () => { registerCalls++; return { carrier: 999 }; };
  const link1b = await M.createOrGetForOrder('u1', 'o1', 'RR123456789CN');
  assert.strictEqual(link1b.code, link1.code);
  assert.strictEqual(registerCalls, 0, 'no new 17TRACK call for an order+number already registered');
  assert.strictEqual(docs.length, 1);

  // a different order, or a corrected tracking number on the same order, gets its own new code
  const link2 = await M.createOrGetForOrder('u1', 'o2', 'RR000000000CN');
  assert.notStrictEqual(link2.code, link1.code);
  const link3 = await M.createOrGetForOrder('u1', 'o1', 'RR999999999CN'); // same order, corrected number
  assert.notStrictEqual(link3.code, link1.code);

  // 17TRACK rejecting/erroring the number still creates a working code (just with no live status yet)
  registerBehavior = async () => { throw new Error('carrier not detected'); };
  const link4 = await M.createOrGetForOrder('u2', 'o9', 'BADNUMBER');
  assert.match(link4.code, /^ELM\d{5}$/);
  assert.strictEqual(link4.carrier17, null);
  assert.strictEqual(link4.registeredAt, null);

  // ---- public lookup ----
  assert.strictEqual(await M.getByCode('doesnotexist'), null);
  const found = await M.getByCode(link1.code.toLowerCase()); // case-insensitive, since a buyer might not type it in caps
  assert.strictEqual(found.code, link1.code);
  assert.strictEqual(found.trackingNumber, 'RR123456789CN', "the model layer still carries the real number - routes/publicTracking.js is what hides it");

  // ---- status updates ----
  await M.saveStatus(link1._id, { status: 'InTransit', detail: 'Left origin facility', at: new Date('2026-01-01') });
  assert.strictEqual((await M.getByCode(link1.code)).status, 'InTransit');

  // the webhook only ever gives us number+carrier back, never our own id or the buyer-facing code
  await M.updateStatusByTrackingNumber('RR000000000CN', 999, { status: 'Delivered', detail: 'Delivered to recipient', at: new Date('2026-02-01') });
  assert.strictEqual((await M.getByCode(link2.code)).status, 'Delivered');
  assert.strictEqual((await M.getByCode(link1.code)).status, 'InTransit', "a different number's status is untouched");

  // ---- getForOrder ----
  const forOrder = await M.getForOrder('u1', 'o1');
  assert.strictEqual(forOrder.code, link3.code, 'the most recent link for that order (the corrected number)');
  assert.strictEqual(await M.getForOrder('u1', 'o-none'), null);

  console.log('tracking links model tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
