const cron = require('node-cron');
const { fetchConversations } = require('../services/ebayMessageService');
const { upsertConversation } = require('../models/conversationsModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { acquireLock } = require('../services/jobLockService');
const EbayAccount = require('../models/schemas/EbayAccount');

/**
 * Syncs eBay conversations (buyer messages, system alerts, cancellation
 * threads) for every connected eBay account, so ELMS's notification bell
 * reflects what's actually in each account's eBay inbox without the user
 * needing to check eBay Seller Hub directly.
 */
async function runConversationSync() {
  const accounts = await EbayAccount.find();

  if (!accounts.length) {
    console.log('[conversation-sync] No eBay accounts are connected.');
    return;
  }

  for (const account of accounts) {
    const userId = account.userId.toString();
    const accountId = account._id.toString();

    try {
      const refreshToken = await getEbayAccountRefreshToken(userId, accountId);
      if (!refreshToken) continue;

      for (let offset = 0; offset < 100; offset += 10) {
        const conversations = await fetchConversations(refreshToken, { limit: 10, offset });
        for (const conv of conversations) {
          await upsertConversation(userId, accountId, conv);
        }
        if (conversations.length < 10) break;
      }
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

module.exports = { startConversationSync, runConversationSync };
