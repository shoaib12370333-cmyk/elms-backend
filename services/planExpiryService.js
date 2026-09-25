/**
 * A monthly / yearly plan ends: the credits end with it and the eBay-account limit goes back to what it was before the plan.
 * (Nothing renews by itself; the buyer buys again.) Admins are never touched. Plans bought before terms existed have no end date.
 */

/** Closes one user's plan if its end date has passed. Returns true when it did. Safe to call twice: only one caller wins. */
async function expireIfDue(userId, now = new Date()) {
  const User = require('../models/schemas/User');
  const user = await User.findOne(
    { _id: userId, role: { $ne: 'admin' }, planExpiresAt: { $ne: null, $lte: now } },
    { email: 1, planName: 1, planExpiresAt: 1, planPrevMaxEbayAccounts: 1 }
  ).lean();
  if (!user) return false;
  // matching the end date we just read means a second caller (or a renewal in between) does not close it again
  const res = await User.updateOne(
    { _id: user._id, planExpiresAt: user.planExpiresAt },
    { $set: { creditBalance: 0, maxEbayAccounts: Math.max(1, Number(user.planPrevMaxEbayAccounts) || 1), planExpiresAt: null, planTerm: null, planName: null, planPrevMaxEbayAccounts: null } }
  );
  if (!(res.modifiedCount || res.nModified)) return false;
  try {
    if (user.email) await require('./emailService').sendPlanEndedEmail({ to: user.email, planName: user.planName, endedAt: user.planExpiresAt });
  } catch (err) {
    console.warn('plan ended email failed:', err.message);
  }
  return true;
}

/** Every plan that has run out (called by the hourly job). Returns how many were closed. */
async function expireDuePlans(now = new Date()) {
  const User = require('../models/schemas/User');
  const due = await User.find({ role: { $ne: 'admin' }, planExpiresAt: { $ne: null, $lte: now } }, { _id: 1 }).limit(500).lean();
  let closed = 0;
  for (const u of due) {
    if (await expireIfDue(u._id, now)) closed += 1;
  }
  return closed;
}

module.exports = { expireIfDue, expireDuePlans };
