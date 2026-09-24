// The referral offer stored in the global settings: defaults when nothing was saved, saving, and refusing silly values.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let doc = null;
stub('models/schemas/Settings', {
  findOne: () => ({ lean: async () => doc }),
  findOneAndUpdate: async (_q, update) => { doc = { ...(doc || {}), ...update }; return { toObject: () => doc }; },
});
const { getReferralSettings, updateReferralSettings } = require('../models/settingsModel');

(async () => {
  // nothing saved yet (an existing database): the defaults, switched on
  assert.deepStrictEqual(await getReferralSettings(), { enabled: true, discountPercent: 10, discountUses: 1, discountDays: 0, rewardCredits: 0 });

  let s = await updateReferralSettings({ discountPercent: 15.555, discountUses: 3, discountDays: 30, rewardCredits: 25 });
  assert.deepStrictEqual(s, { enabled: true, discountPercent: 15.56, discountUses: 3, discountDays: 30, rewardCredits: 25 });
  s = await updateReferralSettings({ enabled: false });
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.discountPercent, 15.56, 'a field that was not sent keeps its value');
  s = await updateReferralSettings({ enabled: true, discountPercent: 0 });
  assert.strictEqual(s.discountPercent, 0, '0% is allowed (reward-only programme)');

  for (const bad of [{ discountPercent: 91 }, { discountPercent: -1 }, { discountPercent: 'abc' }, { discountUses: 0 }, { discountDays: -2 }, { rewardCredits: 2000000 }]) {
    await assert.rejects(() => updateReferralSettings(bad), /must be a number between/, JSON.stringify(bad));
  }
  assert.strictEqual((await getReferralSettings()).discountPercent, 0, 'a refused change changes nothing');
  console.log('referralSettings: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
