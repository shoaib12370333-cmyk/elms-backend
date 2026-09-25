const cron = require('node-cron');
const { withLease } = require('../services/jobLockService');
const { sendNextBatch } = require('../services/announcementService');

/** Every minute: send the next small batch of the active announcement (size and daily cap are admin settings). */
function startAnnouncementSender() {
  cron.schedule('* * * * *', async () => {
    // Held until the batch is finished: a batch of slow mails can take longer than a minute, and a second run beside it would send to
    // the same people again (the position in the list is only saved at the end of a batch).
    try { await withLease('announcement-sender', 30 * 60 * 1000, () => sendNextBatch()); }
    catch (err) { console.error('[announcements] Unexpected error:', err.message); }
  });
  console.log('[announcements] Batch sender scheduled (every minute, only works while an announcement is active).');
}

module.exports = { startAnnouncementSender };
