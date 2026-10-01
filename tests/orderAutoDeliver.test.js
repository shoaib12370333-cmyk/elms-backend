// Auto-marking "shipped" orders as "delivered" once eBay's own estimated delivery date has passed, so a seller never
// has to click "Mark delivered" by hand for an order with no tracking number at all (the only other way ELMS would
// ever learn an order arrived). models/ordersModel.js autoMarkDelivered only ever touches orders that are 'shipped'
// AND have an estDeliveryMax in the past - nothing else (not 'pending'/'ordered_from_amazon', not 'delivered'
// already, not a 'shipped' order with no estimate at all, not one whose estimate is still in the future). The real
// model function runs against a stand-in database; jobs/orderAutoDeliver.js's own logic (log only when something
// changed) is checked against a stand-in model.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---------- the real model function ----------
let updateManyCalls = [];
let nextModifiedCount = 0;
stub('models/schemas/Order', { updateMany: async (filter, update) => { updateManyCalls.push({ filter, update }); return { modifiedCount: nextModifiedCount }; } });
stub('models/schemas/Listing', {});
stub('models/schemas/Import', {});
const { autoMarkDelivered } = require('../models/ordersModel');

(async () => {
  const now = new Date('2026-10-05T03:00:00Z');
  nextModifiedCount = 3;
  const updated = await autoMarkDelivered(now);
  assert.strictEqual(updated, 3);
  assert.deepStrictEqual(updateManyCalls[0].filter, { fulfillmentStatus: 'shipped', estDeliveryMax: { $ne: null, $lte: now } }, 'only shipped orders whose estimate has passed - never pending/ordered_from_amazon/delivered, never one with no estimate, never one whose estimate is still ahead');
  assert.deepStrictEqual(updateManyCalls[0].update, { $set: { fulfillmentStatus: 'delivered' } }, 'only the status changes - trackingNumber/shippingCarrier/everything else is untouched');

  nextModifiedCount = 0;
  assert.strictEqual(await autoMarkDelivered(now), 0, 'nothing to update: 0, not an error');

  // ---------- the job: logs only when something actually changed ----------
  updateManyCalls = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const jobFakes = {
    '../models/ordersModel': { autoMarkDelivered: async (n) => { updateManyCalls.push(n); return 5; } },
    '../services/jobLockService': { acquireLock: async () => true },
  };
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent) { if (jobFakes[request] && parent && /jobs[\\/]orderAutoDeliver\.js$/.test(parent.filename)) return jobFakes[request]; return origLoad.apply(this, arguments); };
  const { runOrderAutoDeliver } = require('../jobs/orderAutoDeliver');
  Module._load = origLoad;
  await runOrderAutoDeliver();
  assert.ok(updateManyCalls[0] instanceof Date, 'called with the current moment');
  assert.ok(logs.some((l) => /Marked 5 order/.test(l)));

  logs.length = 0;
  jobFakes['../models/ordersModel'].autoMarkDelivered = async () => 0;
  Module._load = function (request, parent) { if (jobFakes[request] && parent && /jobs[\\/]orderAutoDeliver\.js$/.test(parent.filename)) return jobFakes[request]; return origLoad.apply(this, arguments); };
  delete require.cache[require.resolve('../jobs/orderAutoDeliver')];
  const { runOrderAutoDeliver: runAgain } = require('../jobs/orderAutoDeliver');
  Module._load = origLoad;
  await runAgain();
  assert.strictEqual(logs.length, 0, 'nothing changed: nothing logged');

  console.log = origLog;
  console.log('order auto-deliver tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
