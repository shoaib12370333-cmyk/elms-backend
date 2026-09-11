const MessageSnippet = require('./schemas/MessageSnippet');

function serialize(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    content: doc.content,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

async function listSnippets(userId) {
  const docs = await MessageSnippet.find({ userId }).sort({ name: 1 });
  return docs.map(serialize);
}

async function createSnippet(userId, name, content) {
  const doc = await MessageSnippet.create({ userId, name, content });
  return serialize(doc);
}

async function updateSnippet(userId, id, name, content) {
  const doc = await MessageSnippet.findOneAndUpdate(
    { _id: id, userId },
    { name, content },
    { new: true, runValidators: true }
  );
  return doc ? serialize(doc) : null;
}

async function deleteSnippet(userId, id) {
  const result = await MessageSnippet.deleteOne({ _id: id, userId });
  return result.deletedCount > 0;
}

module.exports = { listSnippets, createSnippet, updateSnippet, deleteSnippet };
