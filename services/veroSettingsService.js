const User = require('../models/schemas/User');
const { normalizeWord, MAX_WORDS } = require('./veroService');

/** The user's own VeRO words (Settings -> VeRO). What they save is what is flagged; nothing else is. */

function problem(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getVeroWordsOf(userId) {
  const user = await User.findById(userId, { veroWords: 1 }).lean();
  return user && Array.isArray(user.veroWords) ? user.veroWords : [];
}

/** "Nike, Adidas" (or one word per line) adds each; words already saved are skipped. */
async function addWords(userId, input) {
  const raw = (Array.isArray(input) ? input : [input]).flatMap((v) => String(v == null ? '' : v).split(/[,;\n]/));
  const existing = await getVeroWordsOf(userId);
  const have = new Set(existing);
  const toAdd = [];
  const skipped = [];
  for (const item of raw) {
    if (!String(item).trim()) continue;
    const word = normalizeWord(item);
    if (!word) { skipped.push(String(item).trim().slice(0, 60)); continue; }
    if (have.has(word)) continue;
    have.add(word);
    toAdd.push(word);
  }
  if (!toAdd.length && !skipped.length && !raw.some((v) => String(v).trim())) throw problem('Type a word first.');
  if (existing.length + toAdd.length > MAX_WORDS) throw problem('You can save up to ' + MAX_WORDS + ' words. Remove some first.');
  if (toAdd.length) await User.updateOne({ _id: userId }, { $addToSet: { veroWords: { $each: toAdd } } });
  return { words: [...existing, ...toAdd], added: toAdd, skipped };
}

async function removeWord(userId, input) {
  const word = normalizeWord(input);
  if (!word) throw problem('That word is not on your list.', 404);
  await User.updateOne({ _id: userId }, { $pull: { veroWords: word } });
  return getVeroWordsOf(userId);
}

async function clearWords(userId) {
  await User.updateOne({ _id: userId }, { $set: { veroWords: [] } });
  return [];
}

module.exports = { getVeroWordsOf, addWords, removeWord, clearWords };
