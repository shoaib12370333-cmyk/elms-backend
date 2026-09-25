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

async function updateExtensionBackendUrl(url) {
  const clean = String(url || '').trim().replace(/\/$/, '');
  if (!clean || !/^https?:\/\//i.test(clean)) throw new Error('Backend URL must start with http:// or https://.');
  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    { extensionBackendUrl: clean },
    { new: true, upsert: true }
  );
  return serialize(doc);
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

const AI_DEFAULT_MODEL = process.env.TITLE_OPTIMIZER_MODEL || 'claude-haiku-4-5-20251001';
let aiCache = null;

function serializeAi(obj) {
  return {
    aiTitleEnabled: obj.aiTitleEnabled !== false,
    aiDescriptionEnabled: obj.aiDescriptionEnabled !== false,
    aiAspectsEnabled: obj.aiAspectsEnabled !== false,
    aiReplyEnabled: obj.aiReplyEnabled !== false,
    aiModel: obj.aiModel || AI_DEFAULT_MODEL,
    aiDescriptionLength: obj.aiDescriptionLength || 'standard',
    aiCustomInstructions: obj.aiCustomInstructions || '',
  };
}

/** AI settings, cached for 20 seconds so every AI call does not hit the database. */
async function getAiSettings() {
  if (aiCache && Date.now() - aiCache.at < 20000) return aiCache.value;
  const doc = await Settings.findOne({ key: 'global' }).lean();
  aiCache = { at: Date.now(), value: serializeAi(doc || {}) };
  return aiCache.value;
}

async function updateAiSettings(input = {}) {
  const update = {};
  if (input.aiTitleEnabled !== undefined) update.aiTitleEnabled = !!input.aiTitleEnabled;
  if (input.aiDescriptionEnabled !== undefined) update.aiDescriptionEnabled = !!input.aiDescriptionEnabled;
  if (input.aiAspectsEnabled !== undefined) update.aiAspectsEnabled = !!input.aiAspectsEnabled;
  if (input.aiReplyEnabled !== undefined) update.aiReplyEnabled = !!input.aiReplyEnabled;
  if (input.aiModel !== undefined) {
    const model = String(input.aiModel || '').trim();
    if (model && !/^[a-zA-Z0-9._:-]{3,80}$/.test(model)) throw new Error('That does not look like a valid model name.');
    update.aiModel = model || null;
  }
  if (input.aiDescriptionLength !== undefined) {
    if (!['short', 'standard', 'detailed'].includes(input.aiDescriptionLength)) throw new Error('Description length must be short, standard or detailed.');
    update.aiDescriptionLength = input.aiDescriptionLength;
  }
  if (input.aiCustomInstructions !== undefined) update.aiCustomInstructions = String(input.aiCustomInstructions || '').slice(0, 600);
  const doc = await Settings.findOneAndUpdate({ key: 'global' }, update, { new: true, upsert: true });
  aiCache = null;
  return serializeAi(doc.toObject());
}

const REFERRAL_DEFAULTS = { referralEnabled: true, referralDiscountPercent: 10, referralDiscountUses: 1, referralDiscountDays: 0, referralRewardCredits: 0 };
const REFERRAL_RANGES = { referralDiscountPercent: [0, 90], referralDiscountUses: [1, 100], referralDiscountDays: [0, 3650], referralRewardCredits: [0, 1000000] };

/** The referral offer as the admin set it (defaults when nothing was saved yet). */
async function getReferralSettings() {
  const doc = await Settings.findOne({ key: 'global' }).lean();
  const d = doc || {};
  const num = (k) => (Number.isFinite(Number(d[k])) && d[k] !== null && d[k] !== undefined ? Number(d[k]) : REFERRAL_DEFAULTS[k]);
  return {
    enabled: d.referralEnabled === undefined || d.referralEnabled === null ? REFERRAL_DEFAULTS.referralEnabled : !!d.referralEnabled,
    discountPercent: num('referralDiscountPercent'),
    discountUses: Math.max(1, Math.floor(num('referralDiscountUses'))),
    discountDays: Math.max(0, Math.floor(num('referralDiscountDays'))),
    rewardCredits: Math.max(0, Math.floor(num('referralRewardCredits'))),
  };
}

async function updateReferralSettings(input = {}) {
  const update = {};
  if (input.enabled !== undefined) update.referralEnabled = !!input.enabled;
  const map = { discountPercent: 'referralDiscountPercent', discountUses: 'referralDiscountUses', discountDays: 'referralDiscountDays', rewardCredits: 'referralRewardCredits' };
  const labels = { discountPercent: 'The discount', discountUses: 'The number of discounted purchases', discountDays: 'The number of days', rewardCredits: 'The reward' };
  for (const [k, field] of Object.entries(map)) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    const [lo, hi] = REFERRAL_RANGES[field];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(labels[k] + ' must be a number between ' + lo + ' and ' + hi + '.');
    update[field] = k === 'discountPercent' ? Math.round(n * 100) / 100 : Math.floor(n);
  }
  await Settings.findOneAndUpdate({ key: 'global' }, update, { new: true, upsert: true });
  return getReferralSettings();
}

async function getCustomPlanSettings() {
  const doc = await Settings.findOne({ key: 'global' }).lean();
  const { normalizeCustomSettings } = require('../services/planPricing');
  try { return normalizeCustomSettings((doc && doc.customPlan) || {}); } catch (_) { return normalizeCustomSettings({}); }
}

async function updateCustomPlanSettings(input = {}) {
  const { normalizeCustomSettings } = require('../services/planPricing');
  const next = normalizeCustomSettings({ ...(await getCustomPlanSettings()), ...input });
  await Settings.findOneAndUpdate({ key: 'global' }, { customPlan: next }, { new: true, upsert: true });
  return next;
}

const LIMIT_DEFAULTS = { bulkImportMax: 25, bulkJobMax: 1000, mailBatchSize: 20, mailDailyCap: 200, productCacheDays: 7 };
const LIMIT_RANGES = { bulkImportMax: [1, 50], bulkJobMax: [1, 5000], mailBatchSize: [1, 100], mailDailyCap: [1, 100000], productCacheDays: [1, 90] };

async function getLimits() {
  const doc = await Settings.findOne({ key: 'global' }).lean();
  const out = {};
  for (const k of Object.keys(LIMIT_DEFAULTS)) out[k] = Number(doc && doc[k]) || LIMIT_DEFAULTS[k];
  return out;
}

async function updateLimits(input = {}) {
  const update = {};
  for (const k of Object.keys(LIMIT_DEFAULTS)) {
    if (input[k] === undefined) continue;
    const n = Math.floor(Number(input[k]));
    const [lo, hi] = LIMIT_RANGES[k];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(k + ' must be a number between ' + lo + ' and ' + hi + '.');
    update[k] = n;
  }
  await Settings.findOneAndUpdate({ key: 'global' }, update, { new: true, upsert: true });
  return getLimits();
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    ...serializeAi(obj),
    welcomeBonusEnabled: obj.welcomeBonusEnabled,
    welcomeBonusCredits: obj.welcomeBonusCredits,
    chromeExtensionId: obj.chromeExtensionId || null,
    extensionRegistrationUrl: obj.extensionRegistrationUrl || null,
    extensionBackendUrl: obj.extensionBackendUrl || 'https://elms-backend-1-tr5h.onrender.com',
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
  updateExtensionBackendUrl,
  getChromeExtensionId,
  getActionCostSettings,
  updateActionCosts,
  applyActionCostOverridesOnStartup,
  getAiSettings,
  updateAiSettings,
  getLimits,
  updateLimits,
  getReferralSettings,
  updateReferralSettings,
  getCustomPlanSettings,
  updateCustomPlanSettings,
};
