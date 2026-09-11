const Settings = require('./schemas/Settings');
const { ACTION_COSTS, ACTION_COST_METADATA } = require('../config/actionCosts');

/**
 * Returns the global settings document, creating it with defaults if it
 * doesn't exist yet (first time the app runs).
 */
async function getSettings() {
  let doc = await Settings.findOne({ key: 'global' });
  if (!doc) {
    doc = await Settings.create({ key: 'global' });
  }
  return serialize(doc);
}

/**
 * Admin-only: updates the welcome bonus settings. Only provided
 * (non-undefined) fields are changed.
 */
let extensionIdCache = undefined;

async function updateWelcomeBonusSettings({ welcomeBonusEnabled, welcomeBonusCredits }) {
  const update = {};
  if (welcomeBonusEnabled !== undefined) update.welcomeBonusEnabled = welcomeBonusEnabled;
  if (welcomeBonusCredits !== undefined) update.welcomeBonusCredits = welcomeBonusCredits;

  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    update,
    { new: true, upsert: true }
  );
  return serialize(doc);
}

async function updateChromeExtensionId(extensionId) {
  const clean = String(extensionId || '').trim().toLowerCase();
  const update = { chromeExtensionId: clean || null };
  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    update,
    { new: true, upsert: true }
  );
  extensionIdCache = clean || null;
  return serialize(doc);
}

async function getChromeExtensionId() {
  if (extensionIdCache !== undefined) return extensionIdCache;
  const doc = await Settings.findOne({ key: 'global' }).lean();
  extensionIdCache = doc?.chromeExtensionId || null;
  return extensionIdCache;
}

async function updateExtensionRegistrationUrl(url) {
  const clean = String(url || '').trim();
  if (clean && !/^https?:\/\//i.test(clean)) {
    throw new Error('Registration URL must start with http:// or https://.');
  }
  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    { extensionRegistrationUrl: clean || null },
    { new: true, upsert: true }
  );
  return serialize(doc);
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    welcomeBonusEnabled: obj.welcomeBonusEnabled,
    welcomeBonusCredits: obj.welcomeBonusCredits,
    chromeExtensionId: obj.chromeExtensionId || null,
    extensionRegistrationUrl: obj.extensionRegistrationUrl || null,
  };
}

/**
 * Returns the full "Credit Costs" list for the Admin Panel: every key from
 * ACTION_COST_METADATA, each with its current live cost (a DB override if
 * one has been saved, otherwise the code default from config/actionCosts.js)
 * plus whether a DB override is actually in effect for it.
 */
async function getActionCostSettings() {
  const doc = await Settings.findOne({ key: 'global' }).lean();
  const overrides = (doc && doc.actionCosts) || {};

  return ACTION_COST_METADATA.map((meta) => ({
    ...meta,
    defaultCost: ACTION_COSTS[meta.key] ?? 0,
    cost: overrides[meta.key] != null ? Number(overrides[meta.key]) : (ACTION_COSTS[meta.key] ?? 0),
    isOverridden: overrides[meta.key] != null,
  }));
}

/**
 * Admin-only: saves new credit costs for one or more actions. Only keys
 * that are actually part of ACTION_COST_METADATA are accepted (silently
 * ignores anything else, e.g. a stale/renamed key from an old client), and
 * each value must be a non-negative number.
 *
 * Applies the change in two places:
 *   1. Persists it to MongoDB (Settings.actionCosts), so it survives restarts.
 *   2. Mutates the live ACTION_COSTS object in place (Object.assign, not a
 *      reassignment) - every route/job in the app imported the SAME object
 *      reference from config/actionCosts.js, so this takes effect for every
 *      request immediately, with no redeploy or restart needed.
 */
async function updateActionCosts(partialCosts) {
  const validKeys = new Set(ACTION_COST_METADATA.map((m) => m.key));
  const clean = {};

  for (const [key, value] of Object.entries(partialCosts || {})) {
    if (!validKeys.has(key)) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`"${key}" must be a non-negative number.`);
    }
    clean[key] = num;
  }

  if (Object.keys(clean).length === 0) {
    throw new Error('No valid action cost values were provided.');
  }

  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    { $set: Object.fromEntries(Object.entries(clean).map(([k, v]) => [`actionCosts.${k}`, v])) },
    { new: true, upsert: true }
  );

  // Live-apply immediately - see the function comment above.
  Object.assign(ACTION_COSTS, clean);

  return getActionCostSettingsFromDoc(doc);
}

function getActionCostSettingsFromDoc(doc) {
  const overrides = (doc.actionCosts && (doc.actionCosts.toObject ? doc.actionCosts.toObject() : doc.actionCosts)) || {};
  return ACTION_COST_METADATA.map((meta) => ({
    ...meta,
    defaultCost: ACTION_COSTS[meta.key] ?? 0,
    cost: overrides[meta.key] != null ? Number(overrides[meta.key]) : (ACTION_COSTS[meta.key] ?? 0),
    isOverridden: overrides[meta.key] != null,
  }));
}

/**
 * Call once at server startup (after connectDB, before the app starts
 * accepting traffic) to load any previously-saved action cost overrides
 * from MongoDB into the live ACTION_COSTS object, so a restart doesn't
 * silently revert an admin's saved prices back to the code defaults.
 */
async function applyActionCostOverridesOnStartup() {
  try {
    const doc = await Settings.findOne({ key: 'global' }).lean();
    const overrides = (doc && doc.actionCosts) || {};
    const validKeys = new Set(ACTION_COST_METADATA.map((m) => m.key));
    const clean = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (validKeys.has(key) && Number.isFinite(Number(value)) && Number(value) >= 0) {
        clean[key] = Number(value);
      }
    }
    if (Object.keys(clean).length) {
      Object.assign(ACTION_COSTS, clean);
      console.log(`[settings] Applied ${Object.keys(clean).length} saved action-cost override(s) from the database.`);
    }
  } catch (err) {
    // Non-fatal - the app just runs on code defaults for this boot if this fails.
    console.error('[settings] Could not load action-cost overrides:', err.message);
  }
}

module.exports = {
  getSettings,
  updateWelcomeBonusSettings,
  updateChromeExtensionId,
  updateExtensionRegistrationUrl,
  getChromeExtensionId,
  getActionCostSettings,
  updateActionCosts,
  applyActionCostOverridesOnStartup,
};
