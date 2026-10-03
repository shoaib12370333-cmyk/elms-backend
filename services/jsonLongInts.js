/**
 * JSON.parse turns every number into a double, which is exact only up to 2^53 (about 9.007e15). AliExpress ids are 16-17 digits
 * (its own sample shows a sku_id of 12000027158136202), so one sent as a JSON NUMBER can lose its last digits - and an order number
 * that is off by a few would pay, read or "track" a different order. quoteLongIntegers rewrites every bare integer of `minDigits`
 * digits or more into a string BEFORE parsing, so ids come through exactly. Strings are skipped (a long run of digits inside a text
 * stays text), and numbers with a fraction or an exponent are left alone. Everything ELMS does with an id is String(id) anyway.
 *
 * @param {string} text JSON text
 * @param {number} [minDigits=16]
 * @returns {string} JSON text
 */
function quoteLongIntegers(text, minDigits = 16) {
  const src = String(text);
  const n = src.length;
  const out = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < n) {
    const ch = src[i];
    if (ch === '"') { // a string literal: copied whole, escapes included
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i + (ch === '-' ? 1 : 0);
      const digitsStart = j;
      while (j < n && isDigit(src[j])) j += 1;
      const digits = j - digitsStart;
      let integer = digits > 0;
      if (src[j] === '.') { integer = false; j += 1; while (j < n && isDigit(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') { integer = false; j += 1; if (src[j] === '+' || src[j] === '-') j += 1; while (j < n && isDigit(src[j])) j += 1; }
      const token = src.slice(i, j);
      out.push(integer && digits >= minDigits ? '"' + token + '"' : token);
      i = j > i ? j : i + 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** JSON.parse with long integers kept exact (see quoteLongIntegers). Throws like JSON.parse on invalid JSON. */
function parseJsonKeepingLongIds(text, minDigits) {
  return JSON.parse(quoteLongIntegers(text, minDigits));
}

module.exports = { quoteLongIntegers, parseJsonKeepingLongIds };
