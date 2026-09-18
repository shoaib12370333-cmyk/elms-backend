const cron = require('node-cron');
const { fetchConversations } = require('../services/ebayMessageService');
const { upsertConversation, purgeExpiredTrash } = require('../models/conversationsModel');
const { upsertMessages } = require('../models/messagesModel');
const { fetchConversationDetail } = require('../services/ebayMessageService');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const EbayAccount = require('../models/schemas/EbayAccount');

/**
 * Syncs eBay conversations (buyer messages, system alerts, cancellation
 * threads) for every connected eBay account, so ELMS's notification bell
 * reflects what's actually in each account's eBay inbox without the user
 * needing to check eBay Seller Hub directly.
 */
async function syncOneAccountConversations(userId, accountId, refreshToken, lastConversationSyncAt = null) {
  let synced = 0;
  const now = new Date();
  // Initial sync intentionally has NO artificial 30-day cutoff. The eBay
  // Message API is paginated, so we walk every page until eBay returns fewer
  // than the page size. Subsequent syncs use a 48-hour overlap so new/updated
  // conversations around the boundary are not missed.
  const isInitialSync = !lastConversationSyncAt;
  const startTime = lastConversationSyncAt
    ? new Date(lastConversationSyncAt.getTime() - 48 * 60 * 60 * 1000)
    : null;
  const endTime = isInitialSync ? null : now;

  for (const conversationType of ['FROM_MEMBERS', 'FROM_EBAY']) {
    // eBay currently returns at most 10 conversations per getConversations call.
    // Keep walking pages until there are no more results. A very high safety
    // ceiling prevents an unexpected API pagination bug from creating an
    // infinite worker loop, while still allowing tens of thousands of records.
    for (let offset = 0, page = 0; page < 1000; offset += 10, page += 1) {
      const conversations = await fetchConversations(refreshToken, {
        conversationType,
        limit: 10,
        offset,
        ...(startTime ? { startTime: startTime.toISOString() } : {}),
        ...(endTime ? { endTime: endTime.toISOString() } : {}),
      });
      if (conversations.length) {
        await Promise.all(conversations.map(async (conv) => {
          const saved = await upsertConversation(userId, accountId, conv);
          try {
            const detail = await fetchConversationDetail(refreshToken, conv.conversationId, conv.conversationType);
            const normalized = detail.messages || [];
            const last = normalized[normalized.length - 1];
            await upsertMessages({ userId, ebayAccountId: accountId, conversationDoc: { _id: saved.id }, ebayConversationId: conv.conversationId, messages: normalized });
            // Update the cache with the actual latest message direction.
            if (last) {
              const Conversation = require('../models/schemas/Conversation');
              await Conversation.updateOne({ _id: saved.id, userId }, { $set: { lastMessageFromSelf: !!last.isSelf, lastMessageSnippet: last.content || '', lastMessageDate: last.sentDate ? new Date(last.sentDate) : undefined } });
            }
          } catch (detailErr) {
            console.warn(`[conversation-sync] Detail sync failed for ${conv.conversationId}: ${detailErr.message}`);
          }
        }));
        synced += conversations.length;
      }
      if (conversations.length < 10) break;
    }
  }

  await EbayAccount.updateOne({ _id: accountId }, { $set: { lastConversationSyncAt: now } });
  return synced;
}

async function syncConversationsForUser(userId, accountId = null) {
  const accounts = await EbayAccount.find(accountId ? { userId, _id: accountId } : { userId });
  if (!accounts.length) return { accounts: 0, conversations: 0 };

  let synced = 0;
  for (const account of accounts) {
    const refreshToken = await getEbayAccountRefreshToken(userId, account._id.toString());
    if (!refreshToken) continue;
    synced += await syncOneAccountConversations(userId, account._id.toString(), refreshToken, account.lastConversationSyncAt);
  }
  return { accounts: accounts.length, conversations: synced };
}

async function runConversationSync() {
  await purgeExpiredTrash().catch((err) => console.warn('[conversation-sync] Trash purge failed:', err.message));
  const accounts = await EbayAccount.find();
  if (!accounts.length) {
    console.log('[conversation-sync] No eBay accounts are connected.');
    return;
  }

  for (const account of accounts) {
    try {
      const refreshToken = await getEbayAccountRefreshToken(account.userId.toString(), account._id.toString());
      if (!refreshToken) continue;
      const synced = await syncOneAccountConversations(account.userId.toString(), account._id.toString(), refreshToken, account.lastConversationSyncAt);
      console.log(`[conversation-sync] ${account.ebayUserId}: synced ${synced} conversation(s).`);
    } catch (err) {
      console.error(`[conversation-sync] Could not sync messages for eBay account ${account.ebayUserId}: ${err.message}`);
    }
  }
  console.log('[conversation-sync] Conversation sync run complete.');
}

/**
 * Starts the periodic conversation-sync schedule. Runs every 10 minutes -
 * frequent enough to feel current without adding significant API load.
 */
function startConversationSync() {
  cron.schedule('*/10 * * * *', async () => {
    const gotLock = await acquireLock('conversation-sync', 9 * 60 * 1000).catch(() => false);
    if (!gotLock) {
      console.log('[conversation-sync] Another instance already holds the lock for this run, skipping.');
      return;
    }

    runConversationSync().catch((err) => {
      console.error('[conversation-sync] Unexpected error during conversation sync:', err.message);
    });
  });

  console.log('[conversation-sync] Conversation sync scheduled (every 10 minutes).');
}

module.exports = { startConversationSync, runConversationSync, syncConversationsForUser };
