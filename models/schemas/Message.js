const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', required: true },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  ebayConversationId: { type: String, required: true },
  ebayMessageId: { type: String, required: true },
  content: { type: String, default: '' },
  fromUsername: { type: String, default: null },
  isSelf: { type: Boolean, default: false },
  readStatus: { type: Boolean, default: false },
  sentDate: { type: Date, default: null },
  media: [{ _id: false, name: { type: String, default: '' }, type: { type: String, default: '' }, url: { type: String, default: '' } }],
}, { timestamps: true });

messageSchema.index({ userId: 1, ebayAccountId: 1, ebayConversationId: 1, ebayMessageId: 1 }, { unique: true });
messageSchema.index({ conversationId: 1, sentDate: 1 });

module.exports = mongoose.model('Message', messageSchema);
