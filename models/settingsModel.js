const Settings = require('./schemas/Settings');

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

function serialize(doc) {
  const obj = doc.toObject();
  return {
    welcomeBonusEnabled: obj.welcomeBonusEnabled,
    welcomeBonusCredits: obj.welcomeBonusCredits,
  };
}

module.exports = { getSettings, updateWelcomeBonusSettings };
