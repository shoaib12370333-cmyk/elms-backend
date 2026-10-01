// services/buyerMessageService.js: composes the two automatic eBay buyer messages (thank-you, shipped + review
// request) and sends them through the same eBay Message API already used for the Messages inbox
// (services/ebayMessageService.js). No phone numbers, emails or external links in either message - eBay's
// buyer-messaging policy forbids off-eBay contact info, and getting this wrong is exactly the kind of account-safety
// mistake this feature must never cause. Both sends are best effort: a failure is reported back, never thrown.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const sendCalls = [];
let sendFails = false;
stub('services/ebayMessageService', {
  sendMessage: async (refreshToken, body) => {
    sendCalls.push({ refreshToken, body });
    if (sendFails) throw new Error('eBay says no.');
    return { ok: true };
  },
});

const { sendThankYouMessage, sendShippedReviewMessage, sendOrderedUpdateMessage, sendShippedUpdateMessage, thankYouText, shippedReviewText, orderedUpdateText, shippedUpdateText, fillTemplate } = require('../services/buyerMessageService');

(async () => {
  // ---------- message text: buyer's first name only, item title woven in, never a phone/email/external link ----------
  assert.match(thankYouText({ buyerName: 'Jane Doe', itemTitle: 'Blue Mug' }), /^Hi Jane, thank you for your order of Blue Mug!/);
  assert.match(thankYouText({ buyerName: '', itemTitle: '' }), /^Hi there, thank you for your order!/, 'no saved name: a neutral greeting, never blank');
  assert.match(shippedReviewText({ buyerName: 'Sam', itemTitle: 'Red Hat' }), /^Hi Sam, good news - your Red Hat has shipped!/);
  assert.match(shippedReviewText({ buyerName: 'Sam', itemTitle: '' }), /your order has shipped!/, 'no item title: falls back to "order"');
  const noContactInfo = /https?:\/\/|@|\bcall\b|\bemail\b|\bphone\b/i;
  assert.doesNotMatch(thankYouText({ buyerName: 'X', itemTitle: 'Y' }), noContactInfo);
  assert.doesNotMatch(shippedReviewText({ buyerName: 'X', itemTitle: 'Y' }), noContactInfo);

  // ---------- no refresh token / no buyer username: skipped, eBay is never called ----------
  sendCalls.length = 0;
  let r = await sendThankYouMessage(null, { buyerUsername: 'buyer1', itemId: '1', buyerName: 'A', itemTitle: 'B' });
  assert.strictEqual(r.status, 'skipped'); assert.strictEqual(sendCalls.length, 0);
  r = await sendThankYouMessage('rt', { buyerUsername: '', itemId: '1' });
  assert.strictEqual(r.status, 'skipped'); assert.strictEqual(sendCalls.length, 0);
  r = await sendShippedReviewMessage(null, { buyerUsername: 'buyer1' });
  assert.strictEqual(r.status, 'skipped'); assert.strictEqual(sendCalls.length, 0);

  // ---------- sends through ebayMessageService.sendMessage with the buyer username + item reference ----------
  r = await sendThankYouMessage('rt-1', { buyerUsername: 'buyer1', itemId: '110001', buyerName: 'Jane', itemTitle: 'Widget' });
  assert.strictEqual(r.status, 'sent');
  assert.strictEqual(sendCalls[0].refreshToken, 'rt-1');
  assert.strictEqual(sendCalls[0].body.recipientUsername, 'buyer1');
  assert.strictEqual(sendCalls[0].body.itemId, '110001');
  assert.match(sendCalls[0].body.content, /Hi Jane, thank you for your order of Widget!/);

  sendCalls.length = 0;
  r = await sendShippedReviewMessage('rt-2', { buyerUsername: 'buyer2', itemId: '220002', buyerName: 'Sam', itemTitle: 'Gadget' });
  assert.strictEqual(r.status, 'sent');
  assert.strictEqual(sendCalls[0].body.recipientUsername, 'buyer2');
  assert.match(sendCalls[0].body.content, /your Gadget has shipped!/);
  assert.match(sendCalls[0].body.content, /leaving us a review/);

  // ---------- no itemId: still sends, just without a listing reference ----------
  sendCalls.length = 0;
  await sendThankYouMessage('rt-1', { buyerUsername: 'buyer1' });
  assert.strictEqual(sendCalls[0].body.itemId, undefined);

  // ---------- eBay call fails: reported as failed, never thrown ----------
  sendFails = true;
  r = await sendThankYouMessage('rt-1', { buyerUsername: 'buyer1', itemId: '1' });
  assert.strictEqual(r.status, 'failed'); assert.match(r.message, /eBay says no/);
  r = await sendShippedReviewMessage('rt-1', { buyerUsername: 'buyer1', itemId: '1' });
  assert.strictEqual(r.status, 'failed');
  sendFails = false;

  // ---------- the "ordered"/"shipped" update messages: same default-text shape, same no-contact-info rule ----------
  assert.match(orderedUpdateText({ buyerName: 'Jane', itemTitle: 'Blue Mug' }), /^Hi Jane, quick update on your order of Blue Mug - we've placed it with our supplier/);
  assert.match(orderedUpdateText({ buyerName: '', itemTitle: '' }), /^Hi there, quick update on your order - /, 'no saved name/item: a neutral greeting, never blank');
  assert.match(shippedUpdateText({ buyerName: 'Sam', itemTitle: 'Red Hat' }), /^Hi Sam, good news - your order of Red Hat has shipped and is on its way to you!/);
  assert.match(shippedUpdateText({ buyerName: 'Sam', itemTitle: '' }), /your order has shipped/, 'no item title: falls back to "order"');
  assert.doesNotMatch(orderedUpdateText({ buyerName: 'X', itemTitle: 'Y' }), noContactInfo);
  assert.doesNotMatch(shippedUpdateText({ buyerName: 'X', itemTitle: 'Y' }), noContactInfo);

  // ---------- a custom template (the seller's own wording from Settings) wins over the built-in default, with {{buyer_name}}/{{product_name}} filled in ----------
  assert.strictEqual(fillTemplate('Hi {{buyer_name}}, about {{product_name}}...', { buyerName: 'Jane Doe', itemTitle: 'Widget' }), 'Hi Jane, about Widget...');
  assert.strictEqual(fillTemplate('Hi {{BUYER_NAME}}!', { buyerName: 'Sam' }), 'Hi Sam!', 'case-insensitive, matching the Messages page\'s own snippet variables');
  assert.strictEqual(fillTemplate('No placeholders here.', { buyerName: 'Sam', itemTitle: 'X' }), 'No placeholders here.');
  assert.strictEqual(fillTemplate('Hi {{buyer_name}}, re {{product_name}}', { buyerName: 'Sam', itemTitle: '' }), 'Hi Sam, re your item', 'no item title: a neutral fallback, never blank');
  assert.strictEqual(orderedUpdateText({ buyerName: 'Jane', itemTitle: 'Widget', customTemplate: 'Custom: {{buyer_name}} / {{product_name}}' }), 'Custom: Jane / Widget');
  assert.strictEqual(shippedUpdateText({ buyerName: 'Jane', itemTitle: 'Widget', customTemplate: 'Shipped custom for {{buyer_name}}' }), 'Shipped custom for Jane');
  assert.match(orderedUpdateText({ buyerName: 'Jane', itemTitle: 'Widget', customTemplate: '' }), /quick update on your order/, 'an empty custom template falls back to the built-in default, not a blank message');

  // ---------- sending: same skip/send/fail contract as the existing two, customTemplate passed straight through ----------
  sendCalls.length = 0;
  r = await sendOrderedUpdateMessage(null, { buyerUsername: 'buyer1' });
  assert.strictEqual(r.status, 'skipped'); assert.strictEqual(sendCalls.length, 0);
  r = await sendOrderedUpdateMessage('rt-1', { buyerUsername: 'buyer1', itemId: '110001', buyerName: 'Jane', itemTitle: 'Widget' });
  assert.strictEqual(r.status, 'sent'); assert.match(sendCalls[0].body.content, /quick update on your order of Widget/);
  sendCalls.length = 0;
  r = await sendOrderedUpdateMessage('rt-1', { buyerUsername: 'buyer1', buyerName: 'Jane', customTemplate: 'Hi {{buyer_name}}, custom!' });
  assert.strictEqual(sendCalls[0].body.content, 'Hi Jane, custom!');
  sendCalls.length = 0;
  r = await sendShippedUpdateMessage(null, { buyerUsername: 'buyer1' });
  assert.strictEqual(r.status, 'skipped');
  r = await sendShippedUpdateMessage('rt-2', { buyerUsername: 'buyer2', buyerName: 'Sam', itemTitle: 'Gadget' });
  assert.strictEqual(r.status, 'sent'); assert.match(sendCalls[0].body.content, /your order of Gadget has shipped/);

  sendFails = true;
  r = await sendOrderedUpdateMessage('rt-1', { buyerUsername: 'buyer1' });
  assert.strictEqual(r.status, 'failed');
  r = await sendShippedUpdateMessage('rt-1', { buyerUsername: 'buyer1' });
  assert.strictEqual(r.status, 'failed');

  console.log('buyer message service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
