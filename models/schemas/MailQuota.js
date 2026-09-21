const mongoose = require('mongoose');

// How many announcement mails were sent on a given UTC day (YYYY-MM-DD), to enforce the daily cap.
const mailQuotaSchema = new mongoose.Schema({
  day: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 40 },
});

module.exports = mongoose.model('MailQuota', mailQuotaSchema);
