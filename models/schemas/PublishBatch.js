const mongoose = require('mongoose');

/**
 * One "Publish all": the listings that were started together. The person is told once, when every one of them has finished
 * (services/publishBatchService.js), whether they stayed on the page or not.
 */
const publishBatchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  listingIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  total: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 }, // selected, but not started (already live or already being published)
  startedAt: { type: Date, default: Date.now },
  notifiedAt: { type: Date, default: null }, // set (once, atomically) when the "finished" notification was made
}, { timestamps: true });

publishBatchSchema.index({ notifiedAt: 1, startedAt: 1 });
publishBatchSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // a month, then the record goes

module.exports = mongoose.model('PublishBatch', publishBatchSchema);
