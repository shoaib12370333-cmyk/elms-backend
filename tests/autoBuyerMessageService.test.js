// services/autoBuyerMessageService.js: gates the two automatic eBay buyer messages behind (1) the seller's own
// Settings toggle, (2) "only once" (an *MessageAt already set), and, for the thank-you message only, (3) the
// payment being RECENT - a store-connect backlog sync handing upsertOrder an old, already-PAID order line must
// never look like a live "just got paid" moment and thank a buyer for something that happened months ago.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let userDoc = { autoThankYouMessage: false, autoReviewRequestMessage: false };
let tokenFor = async () => 'rt-1';
const updates = [];
const sendCalls = { thankYou: [], review: [] };
let sendResult = { status: 'sent' };

stub('models/schemas/User', { findById: () => ({ select: () => ({ lean: async () => userDoc }) }) });
stub('models/schemas/Order', { updateOne: async (q, u) => { updates.push({ id: q._id, set: u.$set }); } });
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: (...a) => tokenFor(...a) });
stub('services/buyerMessageService', {
  sendThankYouMessage: async (rt, args) => { sendCalls.thankYou.push({ rt, args }); return sendResult; },
  sendShippedReviewMessage: async (rt, args) => { sendCalls.review.push({ rt, args }); return sendResult; },
});

const { maybeSendThankYouMessage, maybeSendReviewRequestMessage } = require('../services/autoBuyerMessageService');
const reset = () => {
  updates.length = 0; sendCalls.thankYou.length = 0; sendCalls.review.length = 0;
  sendResult = { status: 'sent' }; userDoc = { autoThankYouMessage: false, autoReviewRequestMessage: false }; tokenFor = async () => 'rt-1';
};
const base = { userId: 'u1', orderId: 'o1', ebayAccountId: 'a1', buyerUsername: 'buyer1', itemId: '1', itemTitle: 'X', buyerFullName: 'Jane Doe' };

(async () => {
  // ---------- thank-you: not a paid transition -> never even checks the setting ----------
  reset();
  await maybeSendThankYouMessage({ ...base, justPaid: false, paidAt: new Date(), alreadySent: false });
  assert.strictEqual(sendCalls.thankYou.length, 0); assert.strictEqual(updates.length, 0);

  // ---------- already sent -> never resent even if justPaid ----------
  reset();
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: true });
  assert.strictEqual(sendCalls.thankYou.length, 0);

  // ---------- setting is off -> nothing sent, nothing written ----------
  reset(); userDoc.autoThankYouMessage = false;
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: false });
  assert.strictEqual(sendCalls.thankYou.length, 0); assert.strictEqual(updates.length, 0);

  // ---------- an old paidAt (backlog sync) -> never sent, even with the setting on ----------
  reset(); userDoc.autoThankYouMessage = true;
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago > the 48h window
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: old, alreadySent: false });
  assert.strictEqual(sendCalls.thankYou.length, 0, 'too old to be a live payment moment');

  // ---------- setting on + recent + not sent yet -> sends and records thankYouMessageAt ----------
  reset(); userDoc.autoThankYouMessage = true;
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: false });
  assert.strictEqual(sendCalls.thankYou.length, 1);
  assert.strictEqual(sendCalls.thankYou[0].rt, 'rt-1');
  assert.strictEqual(sendCalls.thankYou[0].args.buyerUsername, 'buyer1');
  assert.strictEqual(sendCalls.thankYou[0].args.buyerName, 'Jane Doe');
  assert.strictEqual(updates[0].id, 'o1');
  assert.ok(updates[0].set.thankYouMessageAt instanceof Date);
  assert.strictEqual(updates[0].set.thankYouMessageError, null);

  // ---------- eBay send is skipped/failed -> the reason is recorded, no *MessageAt ----------
  reset(); userDoc.autoThankYouMessage = true; sendResult = { status: 'failed', message: 'boom' };
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: false });
  assert.strictEqual(updates[0].set.thankYouMessageError, 'boom');
  assert.strictEqual(updates[0].set.thankYouMessageAt, undefined);

  // ---------- no refresh token -> still asks the lower-level service, which itself reports "skipped" ----------
  reset(); userDoc.autoThankYouMessage = true; tokenFor = async () => null;
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: false });
  assert.strictEqual(sendCalls.thankYou[0].rt, null);

  // ---------- a thrown error (e.g. the User/Order lookup itself fails) is swallowed, not thrown up to the caller ----------
  reset(); userDoc.autoThankYouMessage = true; tokenFor = async () => { throw new Error('DB is down'); };
  await maybeSendThankYouMessage({ ...base, justPaid: true, paidAt: new Date(), alreadySent: false }); // must not throw
  assert.strictEqual(updates[0].set.thankYouMessageError, 'DB is down');

  // ---------- review-request: no recency guard (a seller manually saving tracking is never a backlog import) ----------
  reset(); userDoc.autoReviewRequestMessage = true;
  await maybeSendReviewRequestMessage({ ...base, justShipped: true, alreadySent: false });
  assert.strictEqual(sendCalls.review.length, 1);
  assert.ok(updates[0].set.reviewMessageAt instanceof Date);

  reset(); userDoc.autoReviewRequestMessage = false;
  await maybeSendReviewRequestMessage({ ...base, justShipped: true, alreadySent: false });
  assert.strictEqual(sendCalls.review.length, 0, 'setting off');

  reset(); userDoc.autoReviewRequestMessage = true;
  await maybeSendReviewRequestMessage({ ...base, justShipped: false, alreadySent: false });
  assert.strictEqual(sendCalls.review.length, 0, 'not a fresh shipment');

  reset(); userDoc.autoReviewRequestMessage = true;
  await maybeSendReviewRequestMessage({ ...base, justShipped: true, alreadySent: true });
  assert.strictEqual(sendCalls.review.length, 0, 'already sent once');

  console.log('auto buyer message service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
