// What ELMS calls a connected eBay account. Never an id that means nothing to a person:
//   the seller's own nickname (set in Settings)  ->  the eBay Store name  ->  the eBay username  ->  "Store 1", "Store 2" ...
// When eBay did not give a username, the account was saved under a placeholder ("eBay Account 1758712345678") - that is never shown.

const PLACEHOLDER = /^eBay Account \d+$/i;
const text = (v) => String(v == null ? '' : v).trim();

/** True for the stand-in name an account gets when eBay could not tell its username. */
function isPlaceholderUsername(id) {
  const v = text(id);
  return !v || PLACEHOLDER.test(v);
}

/** The eBay username when it is a real one, else null. */
function publicUsername(id) {
  return isPlaceholderUsername(id) ? null : text(id);
}

/** The name to show for an account (any object with displayName / storeName / ebayUserId / storeNumber). */
function accountLabel(acc) {
  if (!acc) return 'eBay store';
  const nickname = text(acc.displayName);
  if (nickname) return nickname;
  const store = text(acc.storeName);
  if (store) return store;
  const username = publicUsername(acc.ebayUserId);
  if (username) return username;
  return acc.storeNumber ? `Store ${acc.storeNumber}` : 'eBay store';
}

module.exports = { accountLabel, isPlaceholderUsername, publicUsername };
