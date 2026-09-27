/**
 * The "ELMS: ordered, delivery 30 Sep 2026" mark that "Mark as ordered" puts in an order's private note, in ELMS and (when the seller switched it on) on eBay.
 * The date is the DELIVERY date the seller gives (when the parcel from the supplier arrives); without one the mark is just "ELMS: ordered".
 * Pure text, no eBay and no database: the same rule for both notes. The seller's own text is always kept: the mark is added after it (or replaced when
 * the delivery date changes), and Undo takes out only the mark. Marks written by the first version ("ELMS: ordered 27 Sep 2026") are understood too.
 */

const MAX_NOTE = 255; // the most eBay's note takes
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARK_RE = /(?:\s*\|\s*)?ELMS: ordered(?:,? delivery)?(?: \d{1,2} [A-Za-z]{3} \d{4})?/;
const MARK_TEST = /ELMS: ordered/;

const validDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());
const dateText = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** "ELMS: ordered, delivery 30 Sep 2026", or "ELMS: ordered" when there is no delivery date. */
const markFor = (deliveryDate) => (validDate(deliveryDate) ? `ELMS: ordered, delivery ${dateText(deliveryDate)}` : 'ELMS: ordered');

/** The note without the ELMS mark (and without the " | " that joined it). */
const withoutMark = (note) => String(note || '').replace(MARK_RE, '').replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/\s*\|\s*\|\s*/g, ' | ').trim();

/**
 * What to do with a note. Adding puts the mark after the seller's own text (an old mark is replaced, so a new delivery date takes its place); removing
 * takes only the mark out, and the note is deleted when nothing else is left. When the note is too long for the mark with its date, the short mark is tried.
 * @returns {{ action: 'AddOrUpdate'|'Delete'|'none', text?: string, reason?: string }}
 */
function planNote(existing, ordered, deliveryDate = null, max = MAX_NOTE) {
  const note = String(existing || '').trim();
  const hasMark = MARK_TEST.test(note);
  const rest = hasMark ? withoutMark(note) : note;
  if (ordered) {
    for (const mark of [...new Set([markFor(deliveryDate), 'ELMS: ordered'])]) {
      const next = rest ? `${rest} | ${mark}` : mark;
      if (next.length <= max) return next === note ? { action: 'none', reason: 'The note already says it.' } : { action: 'AddOrUpdate', text: next };
    }
    return { action: 'none', reason: `The note has no room left (${max} characters).` };
  }
  if (!hasMark) return { action: 'none', reason: 'The note has no ELMS mark.' };
  return rest ? { action: 'AddOrUpdate', text: rest } : { action: 'Delete' };
}

/** The note after the mark is added / replaced (ordered = true) or taken out (false): the same text when nothing changes. */
function applyMark(existing, ordered, deliveryDate = null, max = MAX_NOTE) {
  const plan = planNote(existing, ordered, deliveryDate, max);
  if (plan.action === 'AddOrUpdate') return plan.text;
  if (plan.action === 'Delete') return '';
  return String(existing || '');
}

module.exports = { MAX_NOTE, markFor, planNote, applyMark };
