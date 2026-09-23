const { credentialsFor, senderAddress } = require('./emailService');

/**
 * Turns mail sent to the support address into ELMS support tickets, so they show up (and are answered)
 * in the Admin panel -> Tickets, without opening the mailbox.
 *
 * It reads the support mailbox over IMAP (works with any provider; the defaults fit Namecheap Private
 * Email: mail.privateemail.com, port 993, login = the full address):
 *   SUPPORT_IMAP_USER / SUPPORT_IMAP_PASS  - default to SMTP_USER_SUPPORT / SMTP_PASS_SUPPORT
 *   SUPPORT_IMAP_HOST (mail.privateemail.com) / SUPPORT_IMAP_PORT (993)
 *   SUPPORT_INBOX_ENABLED=false            - switch it off
 * A mail is marked as read only after it has been saved, so a failed run is simply retried.
 */

const MAX_PER_RUN = 25;
const MAX_BODY = 10000;
const MAX_TICKETS_PER_SENDER_PER_HOUR = 20;

function imapConfig() {
  if (String(process.env.SUPPORT_INBOX_ENABLED || '').toLowerCase() === 'false') return null;
  const creds = credentialsFor('support');
  const user = String(process.env.SUPPORT_IMAP_USER || (creds.own ? creds.user : '') || '').trim();
  const pass = process.env.SUPPORT_IMAP_PASS || (creds.own ? creds.pass : '');
  if (!user || !pass) return null;
  return {
    host: process.env.SUPPORT_IMAP_HOST || 'mail.privateemail.com',
    port: Number(process.env.SUPPORT_IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  };
}

/** Subject without "Re:/Fwd:" prefixes and without our "[Ticket #...]" code. */
function cleanSubject(subject) {
  let s = String(subject || '').replace(/\[Ticket #[a-f0-9]{8}\]/gi, '');
  let prev;
  do { prev = s; s = s.replace(/^\s*(re|fwd?|aw|wg)\s*:\s*/i, ''); } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().slice(0, 200) || '(no subject)';
}

function extractRef(subject) {
  const m = String(subject || '').match(/\[Ticket #([a-f0-9]{8})\]/i);
  return m ? m[1].toLowerCase() : null;
}

/** Drops the quoted earlier conversation ("On ... wrote:", "> ..." lines) that mail apps append to a reply. */
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(on .+wrote:|-{2,}\s*original message\s*-{2,}|_{5,})\s*$/i.test(line) && i > 0) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Bounces, out-of-office replies, newsletters and our own mail must never become tickets (or loop). */
function isAutomated(parsed, ownAddresses = []) {
  const h = parsed.headers;
  const get = (k) => String((h && h.get && h.get(k)) || '').toLowerCase();
  const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (!from) return true;
  if (ownAddresses.map((a) => String(a).toLowerCase()).includes(from)) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(from)) return true;
  const auto = get('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (/bulk|junk|list|auto_reply/.test(get('precedence'))) return true;
  if (get('x-auto-response-suppress') || get('list-unsubscribe')) return true;
  if (/^(undeliverable|delivery status|automatic reply|auto:|out of office)/i.test(String(parsed.subject || '').trim())) return true;
  return false;
}

/**
 * Saves one parsed mail: a follow-up on an existing ticket (its subject carries "[Ticket #code]") reopens it and
 * adds to its thread; anything else becomes a new ticket, linked to the ELMS user with that email when there is one.
 * @returns {Promise<{ action: 'created'|'appended'|'skipped', reason?: string, ticketId?: string }>}
 */
async function handleParsedMail(parsed, ownAddresses = []) {
  const SupportTicket = require('../models/schemas/SupportTicket');
  const User = require('../models/schemas/User');

  if (isAutomated(parsed, ownAddresses)) return { action: 'skipped', reason: 'automated' };

  const fromEmail = String(parsed.from.value[0].address).toLowerCase();
  const fromName = String(parsed.from.value[0].name || '').trim().slice(0, 120) || undefined;
  const messageId = parsed.messageId ? String(parsed.messageId) : undefined;

  if (messageId && await SupportTicket.exists({ $or: [{ emailMessageId: messageId }, { 'thread.emailMessageId': messageId }] })) {
    return { action: 'skipped', reason: 'duplicate' };
  }

  const body = (stripQuoted(parsed.text || '') || String(parsed.text || '').trim() || '(no text in this email)').slice(0, MAX_BODY);

  const ref = extractRef(parsed.subject);
  if (ref) {
    const ticket = await SupportTicket.findOne({ ref });
    if (ticket) {
      await SupportTicket.updateOne({ _id: ticket._id }, {
        $set: { status: 'open', resolvedAt: null },
        $push: { thread: { from: 'customer', text: body, at: parsed.date || new Date(), emailMessageId: messageId } },
      });
      return { action: 'appended', ticketId: String(ticket._id) };
    }
  }

  const recent = await SupportTicket.countDocuments({ fromEmail, createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } });
  if (recent >= MAX_TICKETS_PER_SENDER_PER_HOUR) return { action: 'skipped', reason: 'rate_limited' };

  const user = await User.findOne({ email: fromEmail }).select('_id').lean();
  const ticket = await SupportTicket.create({
    userId: user ? user._id : undefined,
    subject: cleanSubject(parsed.subject),
    message: body,
    source: 'email',
    fromEmail,
    fromName,
    emailMessageId: messageId,
  });
  return { action: 'created', ticketId: String(ticket._id) };
}

/** One poll: fetch unread mail from the support mailbox, save each as a ticket, mark it read. */
async function pollSupportInbox() {
  const config = imapConfig();
  if (!config) return { skipped: true };
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const own = ['noreply', 'support', 'billing', 'security', 'admin', undefined].map((k) => { try { return senderAddress(k); } catch (_) { return ''; } }).filter(Boolean);
  own.push(config.auth.user);

  const client = new ImapFlow(config);
  client.on('error', (e) => console.warn('[support-inbox] connection error:', e.message));
  const result = { created: 0, appended: 0, skipped: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, MAX_PER_RUN)) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          const outcome = await handleParsedMail(parsed, own);
          result[outcome.action] += 1;
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (mailErr) {
          console.warn(`[support-inbox] could not process message ${uid}: ${mailErr.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

module.exports = { pollSupportInbox, handleParsedMail, cleanSubject, extractRef, stripQuoted, isAutomated, imapConfig };
