const mongoose = require('mongoose');

const messageSnippetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    content: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true }
);

messageSnippetSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('MessageSnippet', messageSnippetSchema);
