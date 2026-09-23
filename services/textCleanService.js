// Amazon pastes invisible direction/zero-width marks (U+200E and friends) in front of many names and
// values. They break matching against eBay's allowed values and show up as odd characters on eBay.
// Built from char codes so no invisible character has to live in this source file.
const ranges = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2060], [0xfeff, 0xfeff]];
const INVISIBLE = new RegExp('[' + ranges.map(([a, b]) => String.fromCharCode(a) + (a === b ? '' : '-' + String.fromCharCode(b))).join('') + ']', 'g');

function stripInvisible(value) {
  return String(value ?? '').replace(INVISIBLE, '');
}

module.exports = { stripInvisible };
