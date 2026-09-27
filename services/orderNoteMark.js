/**
 * The "ELMS: ordered 27 Sep 2026" mark that "Mark as ordered" puts in an order's private note, in ELMS and (when the seller switched it on) on eBay.
 * Pure text, no eBay and no database: the same rule for both notes. The seller's own text is always kept: the mark is added after it, and Undo
 * takes out only the mark.
 */

const MAX_NOTE = 255; // the most eBay's note takes
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARK_RE = /(?:\s*\|\s*)?ELMS: ordered(?: \d{1,2} [A-Za-z]{3} \d{4})?/;
const MARK_TEST = /ELMS: ordered/;

const markFor = (date) => `ELMS: ordered ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/**
 * What to do with a note. Adding puts the mark after the seller's own text; removing takes only the mark out (and the note is deleted when nothing else
 * is left). @returns {{ action: 'AddOrUpdate'|'Delete'|'none', text?: string, reason?: string }}
 */
function planNote(existing, ordered, now = new Date(), max = MAX_NOTE) {
  const note = String(existing || '').trim();
  const hasMark = MARK_TEST.test(note);
  if (ordered) {
    if (hasMark) return { action: 'none', reason: 'The note already says it.' };
    for (const mark of [markFor(now), 'ELMS: ordered']) {
      const next = note ? `${note} | ${mark}` : mark;
      if (next.length <= max) return { action: 'AddOrUpdate', text: next };
    }
    return { action: 'none', reason: `The note has no room left (${max} characters).` };
  }
  if (!hasMark) return { action: 'none', reason: 'The note has no ELMS mark.' };
  const rest = note.replace(MARK_RE, '').replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/\s*\|\s*\|\s*/g, ' | ').trim();
  return rest ? { action: 'AddOrUpdate', text: rest } : { action: 'Delete' };
}

/** The note after the mark is added (ordered = true) or taken out (false): the same text when nothing changes. */
function applyMark(existing, ordered, now = new Date(), max = MAX_NOTE) {
  const plan = planNote(existing, ordered, now, max);
  if (plan.action === 'AddOrUpdate') return plan.text;
  if (plan.action === 'Delete') return '';
  return String(existing || '');
}

module.exports = { MAX_NOTE, markFor, planNote, applyMark };
