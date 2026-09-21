const mongoose = require('mongoose');

// A one-to-many mail (product news, maintenance notice). Sent slowly in batches by jobs/announcementSender.js
// so the SMTP provider's hourly/daily limits are never exceeded. `cursor` is the last user _id already handled.
const announcementSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, maxlength: 8000 },
    status: { type: String, enum: ['sending', 'paused', 'done', 'cancelled'], default: 'sending', index: true },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    // Users whose mail failed (capped) so they can be retried, and the last SMTP error so the admin can see why.
    failedUsers: { type: [{ userId: mongoose.Schema.Types.ObjectId, email: String, retry: { type: Boolean, default: false }, _id: false }], default: [] },
    lastError: { type: String, default: null },
    cursor: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Announcement', announcementSchema);
