// Opening a message thread: reads run together, the buyer profile is refreshed in the background (never awaited),
// eBay is only called when nothing is stored (or a read receipt is pending), and a failed live fetch does not mark it read.
const assert = require('assert');
const Module = require('module');

const log = [];
let conv;
let stored;
let messages;
let token = 'tok';
let liveFails = false;
let profileCalls = 0;
let profileGate; // resolves when the test lets the background refresh finish

const query = (result) => { const q = { populate: () => q, select: () => q, lean: async () => result, catch: () => q, then: (f) => Promise.resolve(result).then(f) }; return q; };
const fakes = {
  '../models/conversationsModel': {
    listConversations: async () => [], countUnreadConversations: async () => 0, upsertConversation: async () => null,
    addInternalNote: async () => null, updateConversationState: async () => null, trashConversation: async () => null, restoreConversation: async () => null,
    getConversationById: async () => conv,
    getConversationForThread: async () => (conv ? { conversation: conv, storedBuyerProfile: stored } : null),
    markConversationRead: async () => { log.push('markRead'); return conv; },
  },
  '../services/ebayBuyerProfileService': { PROFILE_TTL_MS: 7 * 86400000, ensureBuyerProfile: async () => { profileCalls++; await profileGate; return null; } },
  '../services/messageAttachmentService': { saveMessageAttachment: async () => null, sanitizeAttachments: () => [] },
  '../models/schemas/EbayAccount': { findById: () => query({ marketplaceId: 'EBAY_US' }) },
  '../models/messagesModel': { listMessages: async () => messages, upsertMessages: async () => { log.push('upsert'); } },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => token },
  '../services/ebayMessageService': {
    fetchConversationDetail: async () => { log.push('live'); if (liveFails) throw new Error('eBay down'); return { conversationId: 'c', messages: [{ messageId: 'm1', content: 'hi', isSelf: false }] }; },
    sendMessage: async () => null,
    updateConversationStatus: async () => { log.push('ebayRead'); },
  },
  '../models/schemas/Order': { findOne: () => query(null) },
  '../models/schemas/Listing': { findOne: () => query({ _id: 'l1', title: 'Blue lamp', mainImage: 'img', ebayItemId: '123' }) },
  '../jobs/conversationSync': { syncConversationsForUser: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.notifications.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/notifications');

const layer = router.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const open = async (query = {}) => { log.length = 0; const res = fakeRes(); await handler({ userId: 'u1', params: { id: 'c1' }, query }, res); return res; };
const baseConv = () => ({ id: 'c1', ebay_account_id: 'a1', ebay_conversation_id: 'e1', conversation_type: 'FROM_MEMBERS', other_party_username: 'buyer1', reference_id: '123', buyer_profile: null });

(async () => {
  // stored messages -> no eBay fetch; read mark written; listing context found by item id
  conv = baseConv(); stored = { fetchedAt: new Date() }; messages = [{ messageId: 'm1', content: 'hello', isSelf: false, readStatus: false }];
  let res = await open();
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.detail.messages, messages);
  assert.ok(!log.includes('live'), 'stored messages are served without calling eBay');
  assert.ok(log.includes('markRead'));
  assert.strictEqual(res.body.context.type, 'listing');
  assert.strictEqual(res.body.context.listing_title, 'Blue lamp');

  // peeking (loading ahead of time) leaves the thread unread, here and on eBay
  res = await open({ peek: '1' });
  assert.strictEqual(res.body.success, true);
  assert.ok(!log.includes('markRead') && !log.includes('ebayRead'), 'a thread nobody opened stays unread');
  // a live fetch during a peek is still saved, but not marked read
  messages = [];
  res = await open({ peek: '1' });
  assert.deepStrictEqual(log, ['live', 'upsert']);
  messages = [{ messageId: 'm1', content: 'hello', isSelf: false, readStatus: false }];

  // a fresh profile is not refreshed
  profileCalls = 0;
  res = await open();
  assert.strictEqual(profileCalls, 0, 'a profile fetched today is left alone');

  // a stale / missing profile is refreshed in the background: the response does not wait for it
  stored = null; profileCalls = 0;
  let release; profileGate = new Promise((r) => { release = r; });
  res = await open(); // would hang here if the route awaited the (still blocked) refresh
  assert.strictEqual(res.body.success, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(profileCalls, 1, 'the refresh was started');
  release(); profileGate = null;

  // nothing stored -> live fetch, saved, then marked read
  messages = []; stored = { fetchedAt: new Date() };
  res = await open();
  assert.deepStrictEqual(log.filter((x) => x !== 'ebayRead'), ['live', 'upsert', 'markRead']);
  assert.strictEqual(res.body.detail.messages.length, 1);

  // last message ours and not yet read by the buyer -> go live for the receipt, keep serving if eBay is down
  messages = [{ messageId: 'm2', content: 'sent', isSelf: true, readStatus: false }]; liveFails = true;
  res = await open();
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.detail.messages, messages, 'the stored copy is shown when eBay fails');

  // nothing stored and eBay fails -> error, and the conversation is NOT marked read
  messages = [];
  res = await open();
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!log.includes('markRead'), 'a thread that could not be shown stays unread');
  liveFails = false;

  // unknown conversation
  conv = null;
  res = await open();
  assert.strictEqual(res.statusCode, 404);
  console.log('message thread tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
