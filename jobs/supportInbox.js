const cron = require('node-cron');
const { pollSupportInbox, imapConfig } = require('../services/supportInboxService');
const { acquireLock } = require('../services/jobLockService');

/**
 * Every 2 minutes, turns new mail in the support mailbox into support tickets (Admin panel -> Tickets).
 * Does nothing unless the support mailbox login is configured - see services/supportInboxService.js.
 */
function startSupportInbox() {
  if (!imapConfig()) {
    console.log('[support-inbox] Not started: no support mailbox login (set SMTP_USER_SUPPORT/SMTP_PASS_SUPPORT or SUPPORT_IMAP_USER/SUPPORT_IMAP_PASS).');
    return;
  }
  cron.schedule('*/2 * * * *', async () => {
    const gotLock = await acquireLock('support-inbox', 100 * 1000).catch(() => false);
    if (!gotLock) return;
    try {
      const r = await pollSupportInbox();
      if (r && (r.created || r.appended)) console.log(`[support-inbox] ${r.created} new ticket(s), ${r.appended} follow-up(s), ${r.skipped} skipped.`);
    } catch (err) {
      console.warn('[support-inbox] poll failed:', err.message);
    }
  });
  console.log('[support-inbox] Support mailbox polling scheduled (every 2 minutes).');
}

module.exports = { startSupportInbox };
