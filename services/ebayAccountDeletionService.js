/**
 * eBay tells us an eBay user deleted their account (Marketplace Account Deletion notification, routes/ebayAccountDeletion.js).
 * Everything ELMS keeps about that user goes:
 *  - as a SELLER connected to ELMS: the connection and all the data ELMS stored for that store (listings, orders, messages,
 *    notifications, imports) - the same clean-up as when the person disconnects the store themselves;
 *  - as a BUYER in other sellers' data: the personal details on their orders (name, address, email, phone, checkout note) are
 *    erased - the order itself stays for the seller's books - and their conversations and messages are deleted.
 * ELMS stores eBay usernames, so the notification's username (and userId) are matched against those.
 */
const BLANK_ADDRESS = { fullName: null, addressLine1: null, addressLine2: null, city: null, stateOrProvince: null, postalCode: null, country: null };

/**
 * @param {string[]} identifiers the username and / or userId eBay sent
 * @returns {Promise<{ stores: number, orders: number, conversations: number }>}
 */
async function deleteEbayUserData(identifiers) {
  const names = [...new Set((identifiers || []).map((v) => String(v || '').trim()).filter(Boolean))];
  if (!names.length) return { stores: 0, orders: 0, conversations: 0 };
  const EbayAccount = require('../models/schemas/EbayAccount');
  const Order = require('../models/schemas/Order');
  const Conversation = require('../models/schemas/Conversation');
  const Message = require('../models/schemas/Message');
  const { removeEbayAccount } = require('../models/ebayAccountsModel');

  // as a seller: the store and everything kept for it
  let stores = 0;
  const accounts = await EbayAccount.find({ ebayUserId: { $in: names } }).select('_id userId').lean();
  for (const account of accounts) {
    if (await removeEbayAccount(String(account.userId), String(account._id))) stores += 1;
  }

  // as a buyer: erase the person from the orders (the seller keeps the sale) ...
  const orders = await Order.updateMany(
    { buyerUsername: { $in: names } },
    { $set: { buyerUsername: '[deleted]', buyerEmail: null, buyerPhone: null, buyerNote: null, shippingAddress: { ...BLANK_ADDRESS } } }
  );
  // ... and delete their conversations with the message text
  const conversations = await Conversation.find({ $or: [{ otherPartyUsername: { $in: names } }, { fromUsername: { $in: names } }] }).select('_id').lean();
  const ids = conversations.map((c) => c._id);
  if (ids.length) {
    await Message.deleteMany({ conversationId: { $in: ids } });
    await Conversation.deleteMany({ _id: { $in: ids } });
  }
  return { stores, orders: (orders && (orders.modifiedCount || orders.nModified)) || 0, conversations: ids.length };
}

module.exports = { deleteEbayUserData };
