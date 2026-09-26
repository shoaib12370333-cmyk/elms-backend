/**
 * eBay sends some messages (mostly the ones "from eBay": order, payment, policy notices) as a whole HTML document. The Messages page shows
 * the text as it is, so the person saw "<!DOCTYPE html PUBLIC ..." and tags before the real words. messageToText() turns such a body into
 * plain readable text; a body that is already plain text is returned unchanged (so "size < 5" or "a > b" in a buyer's message stays as
 * written). It is applied where a message is saved and where it is read, so messages saved before this fix are shown clean as well.
 */

// A body counts as HTML when it holds at least one real tag from this list.
const LOOKS_HTML = /<\/?(?:!doctype|html|head|body|meta|title|style|script|br|p|div|table|tbody|thead|tr|td|th|span|a|b|i|u|strong|em|ul|ol|li|img|h[1-6]|center|font|hr|blockquote)(?:\s[^>]*)?\/?>/i;

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-',
  hellip: '...', bull: '-', copy: '(c)', reg: '(R)', trade: '(TM)', euro: 'EUR', pound: 'GBP', yen: 'JPY', middot: '.',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code === 160) return ' ';
      try { return String.fromCodePoint(code); } catch (_) { return ''; }
    }
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : whole;
  });
}

/** "text (url)" for a link whose words differ from its address; a very long tracking address loses its query part. */
function linkText(url, inner) {
  const words = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) return words;
  const shown = link.length > 120 ? link.split('?')[0] : link;
  if (!words) return shown;
  if (words === link || words === shown) return words;
  return words + ' (' + shown + ')';
}

/**
 * @param {*} input the message body as eBay gave it
 * @returns {string} plain text
 */
function messageToText(input) {
  const raw = String(input == null ? '' : input);
  if (!LOOKS_HTML.test(raw)) return raw;
  let s = raw.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, '').replace(/<\?xml[^>]*\?>/gi, '');
  s = s.replace(/\s+/g, ' '); // in HTML a line break in the source means nothing: only tags make lines
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, dq, sq, inner) => linkText(decodeEntities(dq || sq || ''), inner));
  s = s.replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (m, dq, sq) => ' ' + (dq || sq || '') + ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<hr\b[^>]*>/gi, '\n---\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|tr|ul|ol|h[1-6]|table|blockquote|center)\s*>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { messageToText };
