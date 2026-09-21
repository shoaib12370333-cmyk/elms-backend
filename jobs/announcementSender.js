const cron = require('node-cron');
const { acquireLock } = require('../services/jobLockService');
const { sendNextBatch } = require('../services/announcementService');

/** Every minute: send the next small batch of the active announcement (size and daily cap are admin settings). */
function startAnnouncementSender() {
  cron.schedule('* * * * *', async () => {
    const gotLock = await acquireLock('announcement-sender', 55 * 1000).catch(() => false);
    if (!gotLock) return;
    sendNextBatch().catch((err) => console.error('[announcements] Unexpected error:', err.message));
  });
  console.log('[announcements] Batch sender scheduled (every minute, only works while an announcement is active).');
}

module.exports = { startAnnouncementSender };
