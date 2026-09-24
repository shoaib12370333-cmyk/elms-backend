const { spendCredit, refundCredit } = require('../models/usersModel');

/** A 402 error for "not enough credits". */
function outOfCredits(cost) {
  const err = new Error(`You need ${cost} credit${cost === 1 ? '' : 's'} for this. Buy credits to continue.`);
  err.statusCode = 402;
  err.outOfCredits = true;
  return err;
}

/**
 * Pays first, then does the work, and gives the credits back if the work fails.
 *
 * Checking the balance and charging later (or ignoring whether the charge worked) lets a user with one credit start many
 * requests at once and get every result for that one credit, so every billable action goes through here: the charge is one
 * atomic database step that only succeeds while the balance covers it, and nothing runs when it does not.
 * Admins and free actions (cost 0) pass without a charge - spendCredit / refundCredit handle that.
 */
async function withCredits(userId, cost, work) {
  const paid = await spendCredit(userId, cost);
  if (!paid) throw outOfCredits(cost);
  try {
    return await work();
  } catch (err) {
    await refundCredit(userId, cost).catch((e) => console.error(`[credits] REFUND FAILED for user ${userId}, ${cost} credit(s): ${e.message}`));
    throw err;
  }
}

module.exports = { withCredits, outOfCredits };
