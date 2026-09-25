const crypto = require('crypto');
const User = require('../models/schemas/User');
const Announcement = require('../models/schemas/Announcement');
const MailQuota = require('../models/schemas/MailQuota');
const { getLimits } = require('../models/settingsModel');
const { sendAnnouncementEmail, senderAddress } = require('./emailService');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set.');
  return s;
}

function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', secret()).update('unsubscribe:' + String(userId)).digest('hex').slice(0, 32);
}

function verifyUnsubscribe(userId, token) {
  const expected = unsubscribeToken(userId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unsubscribeUrl(userId) {
  const base = String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://elms-backend-1-tr5h.onrender.com').replace(/\/$/, '');
  return base + '/api/unsubscribe?u=' + encodeURIComponent(String(userId)) + '&t=' + unsubscribeToken(userId);
}

const today = () => new Date().toISOString().slice(0, 10);

async function sentToday() {
  const doc = await MailQuota.findOne({ day: today() }).lean();
  return doc ? doc.count : 0;
}

const recipientFilter = { marketingOptOut: { $ne: true }, email: { $exists: true, $ne: null } };

async function countRecipients() {
  return User.countDocuments(recipientFilter);
}

async function startAnnouncement({ subject, body, createdBy, sender = 'support' }) {
  const running = await Announcement.findOne({ status: { $in: ['sending', 'paused'] } });
  if (running) throw new Error('Another announcement is still being sent. Cancel or wait for it first.');
  const total = await countRecipients();
  if (!total) throw new Error('There are no users to send to.');
  return Announcement.create({ subject, body, total, createdBy, sender });
}

const MAX_FAILED_KEPT = 2000;

function shortError(err) {
  return String((err && err.message) || err || 'Unknown error').slice(0, 300);
}

/**
 * Sends the next batch of the active announcement. Respects the batch size and the daily cap.
 * Users whose mail failed are remembered (so "Retry failed" can resend them). If EVERY mail in a batch fails,
 * that is a setup problem (SMTP login, sender not allowed...), so the announcement is paused with the error
 * instead of working through the whole list.
 */
async function sendNextBatch() {
  const ann = await Announcement.findOne({ status: 'sending' }).sort({ createdAt: 1 });
  if (!ann) return { sent: 0 };
  const limits = await getLimits();
  const used = await sentToday();
  const room = Math.max(0, limits.mailDailyCap - used);
  if (room === 0) return { sent: 0, capped: true };
  const size = Math.min(limits.mailBatchSize, room);

  // Retries first, then fresh users after the cursor.
  const retrying = (ann.failedUsers || []).filter((f) => f.retry);
  let batch;
  let fromRetry = false;
  if (retrying.length) {
    fromRetry = true;
    batch = retrying.slice(0, size).map((f) => ({ _id: f.userId, email: f.email }));
  } else {
    const query = Object.assign({}, recipientFilter);
    if (ann.cursor) query._id = { $gt: ann.cursor };
    batch = await User.find(query).sort({ _id: 1 }).limit(size).select('email').lean();
  }
  if (!batch.length) {
    ann.status = 'done';
    ann.finishedAt = new Date();
    await ann.save();
    return { sent: 0, done: true };
  }

  const startCursor = ann.cursor;
  let sent = 0;
  const failures = [];
  let lastError = null;
  for (const user of batch) {
    try {
      await sendAnnouncementEmail({ to: user.email, subject: ann.subject, body: ann.body, unsubscribeUrl: unsubscribeUrl(user._id), sender: ann.sender || 'support' });
      sent++;
    } catch (err) {
      lastError = shortError(err);
      failures.push({ userId: user._id, email: user.email });
    }
    if (!fromRetry) ann.cursor = user._id;
  }

  if (sent === 0 && failures.length) {
    // Nothing got through: stop, keep the position, show the reason.
    if (!fromRetry) ann.cursor = startCursor;
    ann.status = 'paused';
    ann.lastError = lastError;
    await ann.save();
    return { sent: 0, failed: failures.length, paused: true };
  }

  const doneIds = new Set(batch.map((u) => String(u._id)));
  if (fromRetry) {
    // Retried users leave the retry list; the ones that failed again go back as normal failures.
    ann.failedUsers = (ann.failedUsers || []).filter((f) => !doneIds.has(String(f.userId)));
    ann.failed = Math.max(0, ann.failed - sent);
  } else {
    ann.failed += failures.length;
  }
  for (const f of failures) {
    if (ann.failedUsers.length >= MAX_FAILED_KEPT) break;
    ann.failedUsers.push({ userId: f.userId, email: f.email });
  }
  ann.sent += sent;
  if (lastError) ann.lastError = lastError;
  await ann.save();
  if (sent) await MailQuota.updateOne({ day: today() }, { $inc: { count: sent } }, { upsert: true });
  return { sent, failed: failures.length };
}

/** Marks every remembered failure for retry and (re)starts the announcement. Returns how many will be retried. */
async function retryFailed(id) {
  const ann = await Announcement.findById(id);
  if (!ann) throw new Error('Announcement not found.');
  if (ann.status === 'cancelled') throw new Error('This announcement was cancelled.');
  const list = ann.failedUsers || [];
  if (!list.length) throw new Error('There are no failed mails to retry.');
  const other = await Announcement.findOne({ _id: { $ne: ann._id }, status: { $in: ['sending', 'paused'] } });
  if (other) throw new Error('Another announcement is still being sent. Finish or cancel it first.');
  for (const f of list) f.retry = true;
  ann.markModified('failedUsers');
  ann.status = 'sending';
  ann.finishedAt = null;
  ann.lastError = null;
  await ann.save();
  return list.length;
}

async function sendTest({ to, subject, body, sender = 'support' }) {
  return sendAnnouncementEmail({ to, subject: '[TEST] ' + subject, body, unsubscribeUrl: 'https://elmstool.com/unsubscribe-test', listUnsubscribe: false, sender });
}

module.exports = { retryFailed, unsubscribeToken, verifyUnsubscribe, unsubscribeUrl, sentToday, countRecipients, startAnnouncement, sendNextBatch, sendTest, senderAddress };
