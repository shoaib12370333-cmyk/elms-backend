const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { SITE_IDS } = require('./ebayStatsService');
const { reserve, markExhausted, isLimitFailure } = require('./ebayCallBudget');

/**
 * "Mark as ordered" can also write a short note on the eBay order, so it is there in eBay too. It uses eBay's Trading API (the newer Fulfillment API has
 * no call to write an order note):
 *   - GetMyeBaySelling (SoldList, orders awaiting shipment) finds the order line and reads the private note that is already on it,
 *   - SetUserNotes writes the note back.
 * SetUserNotes REPLACES the whole note (255 characters at most), so the note is always read first and the ELMS mark is added to it (or taken out of it on
 * Undo): what the seller wrote themselves is kept. If the current note cannot be read, nothing is written. Only the seller sees this note.
 * Every step is best effort and never throws: the ELMS mark does not depend on it.
 */

const { MAX_NOTE, markFor, planNote } = require('./orderNoteMark');

const MAX_PAGES = 3; // 200 orders awaiting shipment each

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = String(xml).match(new RegExp(String.raw`<${name}>([\s\S]*?)</${name}>`)); return m ? unescapeXml(m[1]).trim() : ''; };

/**
 * The order lines and their private notes out of a GetMyeBaySelling SoldList answer. The note is looked for inside each line's own block (wherever eBay
 * puts it there), so a slightly different layout still reads right. @returns {{ lines: Array<{ orderId, itemId, transactionId, note }>, totalPages: number }}
 */
function parseSoldList(xml) {
  const text = String(xml || '');
  const lines = [];
  const blocks = text.match(/<OrderTransaction>[\s\S]*?<\/OrderTransaction>/g) || [];
  for (const block of blocks) {
    const orderId = tag(block, 'OrderID');
    for (const tx of block.match(/<Transaction>[\s\S]*?<\/Transaction>/g) || []) {
      lines.push({ orderId: tag(tx, 'OrderID') || orderId, itemId: tag(tx, 'ItemID'), transactionId: tag(tx, 'TransactionID'), note: tag(tx, 'PrivateNotes') });
    }
  }
  return { lines, totalPages: Number(tag(text, 'TotalNumberOfPages')) || 1 };
}

/**
 * The line of the order among the lines eBay listed. Never a guess: the item AND the order number must agree (eBay gives no order number in one
 * layout: then the only line of that item is taken). @returns {{ line?: object, reason?: string }}
 */
function pickLine(lines, { orderId, itemId }) {
  const sameItem = lines.filter((l) => l.itemId === String(itemId));
  if (!sameItem.length) return { reason: 'not_found' };
  const seen = sameItem.map((l) => l.orderId || '(no order number)');
  const exact = sameItem.filter((l) => l.orderId && l.orderId === String(orderId));
  if (exact.length === 1) return { line: exact[0] };
  if (exact.length > 1) return { reason: 'ambiguous', seen };
  const noOrder = sameItem.filter((l) => !l.orderId);
  if (noOrder.length === 1 && sameItem.length === 1) return { line: noOrder[0] };
  return { reason: sameItem.length > 1 ? 'ambiguous' : 'order_mismatch', seen };
}

async function callTrading(refreshToken, marketplaceId, callName, body) {
  const accessToken = await getAccessToken(refreshToken);
  let response;
  try {
    response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
      headers: { 'Content-Type': 'text/xml', 'X-EBAY-API-CALL-NAME': callName, 'X-EBAY-API-COMPATIBILITY-LEVEL': '1193', 'X-EBAY-API-SITEID': String(SITE_IDS[marketplaceId] ?? 0), 'X-EBAY-API-IAF-TOKEN': accessToken },
      timeout: 25000,
      responseType: 'text',
      transformResponse: (r) => r,
    });
  } catch (err) {
    const wrapped = new Error('Could not reach eBay.');
    wrapped.statusCode = 502;
    throw wrapped;
  }
  const xml = String(response.data || '');
  if (/<Ack>\s*Failure\s*<\/Ack>/i.test(xml)) {
    const message = tag(xml, 'LongMessage') || tag(xml, 'ShortMessage') || `eBay refused ${callName}.`;
    const limitReached = isLimitFailure(tag(xml, 'ErrorCode'), message);
    if (limitReached) markExhausted();
    const wrapped = new Error(message);
    wrapped.statusCode = 502;
    wrapped.limitReached = limitReached;
    throw wrapped;
  }
  return xml;
}

const soldListRequest = (page) => `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <SoldList>
    <Include>true</Include>
    <OrderStatusFilter>AwaitingShipment</OrderStatusFilter>
    <DurationInDays>60</DurationInDays>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </SoldList>
  <OutputSelector>SoldList.OrderTransactionArray</OutputSelector>
  <OutputSelector>SoldList.PaginationResult</OutputSelector>
</GetMyeBaySellingRequest>`;

const setNoteRequest = ({ itemId, transactionId, action, text }) => `<?xml version="1.0" encoding="utf-8"?>
<SetUserNotesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Action>${action}</Action>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <TransactionID>${escapeXml(transactionId)}</TransactionID>${action === 'Delete' ? '' : `
  <NoteText>${escapeXml(text)}</NoteText>`}
</SetUserNotesRequest>`;

const failed = (err) => ({ status: 'failed', message: err && err.message ? err.message : 'eBay did not answer.' });
const budgetMessage = "eBay's daily allowance for this kind of call is used up. Try again tomorrow.";

/**
 * Adds (ordered = true; with the delivery date when there is one) or takes away (false) the ELMS mark in the eBay note of an order.
 * @param {string} refreshToken the store's eBay token
 * @param {string} marketplaceId the store's eBay site
 * @param {{ orderId: string, itemId: string, ordered: boolean, deliveryDate?: Date|null }} order eBay's order number and item number
 * @returns {Promise<{ status: 'written'|'removed'|'unchanged'|'skipped'|'failed', message?: string, note?: string }>} never throws
 */
async function syncOrderNote(refreshToken, marketplaceId, { orderId, itemId, ordered, deliveryDate = null }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!orderId || !itemId) return { status: 'skipped', message: 'This order has no eBay order number or item number, so its eBay note cannot be found.' };
  try {
    // 1. find the order line and read the note that is on it
    let found = null;
    let reason = 'not_found';
    let seen = [];
    let listed = 0; // how many order lines eBay listed in all
    for (let page = 1; page <= MAX_PAGES && !found; page += 1) {
      if (!(await reserve('note', 1))) return { status: 'skipped', message: budgetMessage };
      const { lines, totalPages } = parseSoldList(await callTrading(refreshToken, marketplaceId, 'GetMyeBaySelling', soldListRequest(page)));
      listed += lines.length;
      const picked = pickLine(lines, { orderId, itemId });
      if (picked.line) found = picked.line;
      else if (picked.reason !== 'not_found') { reason = picked.reason; seen = picked.seen || []; break; }
      if (page >= totalPages) break;
    }
    if (!found) {
      // The reason says what eBay showed, so it can be read from the order window without looking in any log.
      const why = reason === 'ambiguous' || reason === 'order_mismatch'
        ? `eBay lists ${seen.length} line(s) for item ${itemId} with order number(s) ${seen.join(', ')}; this order is ${orderId}. The right one could not be told for certain, so nothing was written.`
        : listed
          ? `eBay's list of orders awaiting shipment (${listed} line${listed === 1 ? '' : 's'}) has no line for item ${itemId}: the order may be shipped already, so its note was not changed.`
          : "eBay's list of orders awaiting shipment came back empty: the order may be shipped already (or eBay did not show it), so its note was not changed.";
      // Full detail, not just the summary above - the exact item/order ids eBay listed, so a real failure can be diagnosed from this log
      // alone, without needing to reproduce it. (These are the seller's own item/order numbers, already visible to them on eBay.)
      console.warn(`[ebay-note] no line for order ${orderId} item ${itemId}: ${reason}, ${listed} line(s) listed in all, matching item: ${JSON.stringify(seen)}`);
      return { status: 'skipped', message: why };
    }
    // 2. what to write
    const plan = planNote(found.note, ordered, deliveryDate);
    if (plan.action === 'none') return { status: 'unchanged', message: plan.reason, note: found.note };
    // 3. write it (the whole note: the seller's own text is in it)
    if (!(await reserve('note', 1))) return { status: 'skipped', message: budgetMessage };
    await callTrading(refreshToken, marketplaceId, 'SetUserNotes', setNoteRequest({ itemId: found.itemId, transactionId: found.transactionId, action: plan.action, text: plan.text }));
    return { status: ordered ? 'written' : 'removed', note: plan.action === 'Delete' ? '' : plan.text };
  } catch (err) {
    console.warn('[ebay-note] failed:', err.message);
    return failed(err);
  }
}

/**
 * Adds "Amazon order <id>" to the eBay order's private note, after the seller's own text and any "ELMS: ordered" mark
 * (Auto Order writes this once it has actually placed the Amazon order). Independent of syncOrderNote/planNote above -
 * a different mark, so both can sit in the same note together. Best effort, like syncOrderNote: never throws.
 * @returns {Promise<{ status: 'written'|'unchanged'|'skipped'|'failed', message?: string }>}
 */
async function writeAmazonOrderNote(refreshToken, marketplaceId, { orderId, itemId, amazonOrderId }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!orderId || !itemId) return { status: 'skipped', message: 'This order has no eBay order number or item number, so its eBay note cannot be found.' };
  const mark = `Amazon order ${String(amazonOrderId || '').trim()}`;
  if (!amazonOrderId) return { status: 'skipped', message: 'No Amazon order ID was given.' };
  try {
    let found = null;
    let reason = 'not_found';
    for (let page = 1; page <= MAX_PAGES && !found; page += 1) {
      if (!(await reserve('note', 1))) return { status: 'skipped', message: budgetMessage };
      const { lines, totalPages } = parseSoldList(await callTrading(refreshToken, marketplaceId, 'GetMyeBaySelling', soldListRequest(page)));
      const picked = pickLine(lines, { orderId, itemId });
      if (picked.line) found = picked.line;
      else if (picked.reason !== 'not_found') { reason = picked.reason; break; }
      if (page >= totalPages) break;
    }
    if (!found) {
      console.warn(`[ebay-note] amazon-order-id: no line for order ${orderId} item ${itemId}: ${reason}`);
      return { status: 'skipped', message: "eBay's list of orders awaiting shipment has no line for this order, so its note was not changed." };
    }
    const existing = String(found.note || '').trim();
    if (existing.includes(mark)) return { status: 'unchanged', message: 'The note already says it.' };
    const next = existing ? `${existing} | ${mark}` : mark;
    const text = next.length <= MAX_NOTE ? next : mark.slice(0, MAX_NOTE);
    if (!(await reserve('note', 1))) return { status: 'skipped', message: budgetMessage };
    await callTrading(refreshToken, marketplaceId, 'SetUserNotes', setNoteRequest({ itemId: found.itemId, transactionId: found.transactionId, action: 'AddOrUpdate', text }));
    return { status: 'written' };
  } catch (err) {
    console.warn('[ebay-note] amazon-order-id write failed:', err.message);
    return failed(err);
  }
}

module.exports = { syncOrderNote, writeAmazonOrderNote, planNote, parseSoldList, pickLine, setNoteRequest, soldListRequest, markFor, MAX_NOTE };
