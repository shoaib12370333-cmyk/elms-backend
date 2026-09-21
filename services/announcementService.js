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

async function startAnnouncement({ subject, body, createdBy }) {
  const running = await Announcement.findOne({ status: { $in: ['sending', 'paused'] } });
  if (running) throw new Error('Another announcement is still being sent. Cancel or wait for it first.');
  const total = await countRecipients();
  if (!total) throw new Error('There are no users to send to.');
  return Announcement.create({ subject, body, total, createdBy });
}

/** Sends the next batch of the active announcement. Respects the batch size and the daily cap. */
async function sendNextBatch() {
  const ann = await Announcement.findOne({ status: 'sending' }).sort({ createdAt: 1 });
  if (!ann) return { sent: 0 };
  const limits = await getLimits();
  const used = await sentToday();
  const room = Math.max(0, limits.mailDailyCap - used);
  if (room === 0) return { sent: 0, capped: true };

  const query = Object.assign({}, recipientFilter);
  if (ann.cursor) query._id = { $gt: ann.cursor };
  const users = await User.find(query).sort({ _id: 1 }).limit(Math.min(limits.mailBatchSize, room)).select('email').lean();
  if (!users.length) {
    ann.status = 'done';
    ann.finishedAt = new Date();
    await ann.save();
    return { sent: 0, done: true };
  }

  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await sendAnnouncementEmail({ to: user.email, subject: ann.subject, body: ann.body, unsubscribeUrl: unsubscribeUrl(user._id) });
      sent++;
    } catch (err) {
      failed++;
    }
    ann.cursor = user._id;
  }
  ann.sent += sent;
  ann.failed += failed;
  await ann.save();
  if (sent) await MailQuota.updateOne({ day: today() }, { $inc: { count: sent } }, { upsert: true });
  return { sent, failed };
}

async function sendTest({ to, subject, body }) {
  return sendAnnouncementEmail({ to, subject: '[TEST] ' + subject, body, unsubscribeUrl: 'https://elmstool.com/unsubscribe-test', listUnsubscribe: false });
}

module.exports = { unsubscribeToken, verifyUnsubscribe, unsubscribeUrl, sentToday, countRecipients, startAnnouncement, sendNextBatch, sendTest, senderAddress };
