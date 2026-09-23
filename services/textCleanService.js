// Amazon pastes invisible direction/zero-width marks (U+200E and friends) in front of many names and
// values. They break matching against eBay's allowed values and show up as odd characters on eBay.
// Built from char codes so no invisible character has to live in this source file.
const ranges = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2060], [0xfeff, 0xfeff]];
const INVISIBLE = new RegExp('[' + ranges.map(([a, b]) => String.fromCharCode(a) + (a === b ? '' : '-' + String.fromCharCode(b))).join('') + ']', 'g');
// Combining accents (U+0300-U+036F), so "pokémon" and "pokemon" compare equal.
const ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const CURLY_QUOTES = new RegExp('[' + String.fromCharCode(0x2018) + String.fromCharCode(0x2019) + ']', 'g');

function stripInvisible(value) {
  return String(value ?? '').replace(INVISIBLE, '');
}

/**
 * Text with accents removed and curly quotes made straight, plus a map from every character of the
 * result back to its index in the original (so a match found in the folded text can be cut out of the original).
 */
function foldWithMap(value) {
  const text = String(value ?? '');
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i].normalize('NFD').replace(ACCENTS, '').replace(CURLY_QUOTES, "'");
    for (let k = 0; k < piece.length; k++) { out += piece[k]; map.push(i); }
  }
  return { text: out, map };
}

/** Same folding as foldWithMap, for callers that only need the text. */
function fold(value) {
  return String(value ?? '').normalize('NFD').replace(ACCENTS, '').replace(CURLY_QUOTES, "'");
}

module.exports = { stripInvisible, fold, foldWithMap };
