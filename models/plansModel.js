const Plan = require('./schemas/Plan');

/**
 * Admin-only: creates a new credit plan, linked to a Paddle price ID.
 */
async function createPlan({ name, priceUsd, credits, paddlePriceId }) {
  const doc = await Plan.create({ name, priceUsd, credits, paddlePriceId });
  return serialize(doc);
}

/**
 * Admin-only: updates an existing plan's fields. Only provided (non-undefined)
 * fields are changed.
 */
async function updatePlan(id, { name, priceUsd, credits, paddlePriceId, active }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (priceUsd !== undefined) update.priceUsd = priceUsd;
  if (credits !== undefined) update.credits = credits;
  if (paddlePriceId !== undefined) update.paddlePriceId = paddlePriceId;
  if (active !== undefined) update.active = active;

  const doc = await Plan.findByIdAndUpdate(id, update, { new: true });
  return doc ? serialize(doc) : null;
}

/**
 * Admin-only: permanently removes a plan.
 */
async function deletePlan(id) {
  const doc = await Plan.findByIdAndDelete(id);
  return !!doc;
}

/**
 * Admin-only: returns every plan (active and inactive), for the Admin Panel's
 * "Manage Plans" list.
 */
async function listAllPlans() {
  const docs = await Plan.find().sort({ priceUsd: 1 });
  return docs.map(serialize);
}

/**
 * Returns only active plans, for the user-facing Pricing page.
 */
async function listActivePlans() {
  const docs = await Plan.find({ active: true }).sort({ priceUsd: 1 });
  return docs.map(serialize);
}

/**
 * Looks up a single plan by ID - used when creating a Paddle checkout, to
 * confirm the plan exists and get its Paddle price ID and credit amount.
 */
async function getPlanById(id) {
  const doc = await Plan.findById(id);
  return doc ? serialize(doc) : null;
}

/**
 * Looks up a plan by its Paddle price ID - used by the payment webhook to
 * figure out which plan (and how many credits) a completed transaction corresponds to.
 */
async function getPlanByPaddlePriceId(paddlePriceId) {
  const doc = await Plan.findOne({ paddlePriceId });
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    name: obj.name,
    priceUsd: obj.priceUsd,
    credits: obj.credits,
    paddlePriceId: obj.paddlePriceId,
    active: obj.active,
  };
}

module.exports = { createPlan, updatePlan, deletePlan, listAllPlans, listActivePlans, getPlanById, getPlanByPaddlePriceId };
