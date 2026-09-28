const crypto = require('crypto');
const TrackingLink = require('./schemas/TrackingLink');
const track17 = require('../services/track17Service');

function generateCode() {
  return 'ELM' + crypto.randomInt(10000, 99999);
}

/**
 * The buyer-facing tracking code for one order's tracking number: creates it (and registers the number with
 * 17TRACK) the first time, or returns the existing one if this exact order+number was already registered - so
 * re-saving the same tracking number never makes a second code or a second 17TRACK registration.
 */
async function createOrGetForOrder(userId, orderId, trackingNumber) {
  const existing = await TrackingLink.findOne({ orderId, trackingNumber });
  if (existing) return existing;

  let code = null;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = generateCode();
    if (!(await TrackingLink.exists({ code: candidate }))) code = candidate;
  }
  if (!code) throw new Error('Could not generate a unique tracking code.');

  let carrier17 = null;
  let registeredAt = null;
  try {
    const result = await track17.registerTracking(trackingNumber);
    carrier17 = result.carrier;
    registeredAt = new Date();
  } catch (err) {
    // The code and link are still created - the tracking page just shows "not available yet" until this is
    // resolved (e.g. by hand, or the seller re-saving a corrected tracking number).
    console.warn('[order-tracking-page] 17TRACK register failed for', trackingNumber, ':', err.message);
  }

  return TrackingLink.create({ code, userId, orderId, trackingNumber, carrier17, registeredAt });
}

/** The existing tracking-page code for this order, if a tracking number has already been saved for it (does not create one). */
async function getForOrder(userId, orderId) {
  return TrackingLink.findOne({ userId, orderId }).sort({ createdAt: -1 }).lean();
}

async function getByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return null;
  return TrackingLink.findOne({ code: clean }).lean();
}

async function saveStatus(id, status) {
  return TrackingLink.updateOne({ _id: id }, { $set: { status: status.status, statusDetail: status.detail, statusAt: status.at } });
}

/** Used by the 17TRACK webhook, which only ever gives us the tracking number + its carrier code back - never our own id. */
async function updateStatusByTrackingNumber(trackingNumber, carrier, status) {
  return TrackingLink.updateMany(
    { trackingNumber, ...(carrier ? { carrier17: carrier } : {}) },
    { $set: { status: status.status, statusDetail: status.detail, statusAt: status.at } }
  );
}

module.exports = { createOrGetForOrder, getForOrder, getByCode, saveStatus, updateStatusByTrackingNumber };
