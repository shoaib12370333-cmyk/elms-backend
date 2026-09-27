// "Mark as ordered" also writes "ELMS: ordered <date>" in the private note of the eBay order (Trading API: GetMyeBaySelling to find the order and read its note,
// SetUserNotes to write it back). SetUserNotes REPLACES the whole note, so the note is always read first and the mark is added to / taken out of what the seller
// wrote; nothing is written when the note cannot be read or the order cannot be told for certain. The real service runs; eBay (axios) is a stand-in.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let reserveOk = true;
const reserved = [];
let exhausted = 0;
stub('services/ebayAuthService', { getAccessToken: async () => 'iaf-token' });
stub('services/ebayCallBudget', { reserve: async (kind, n) => { reserved.push([kind, n]); return reserveOk; }, markExhausted: () => { exhausted += 1; }, isLimitFailure: (code) => String(code) === '518', record: async () => {}, snapshot: async () => ({}) });

const axios = require('axios');
const calls = [];
let script = () => { throw new Error('no script'); };
axios.post = async (url, body, opts) => { calls.push({ url, body, name: opts.headers['X-EBAY-API-CALL-NAME'], headers: opts.headers }); const r = await script(calls[calls.length - 1], calls.length); return { data: r }; };

const N = require('../services/ebayOrderNoteService');
const NOW = new Date('2026-09-27T10:00:00Z');

const tx = ({ orderId, itemId, transactionId, note }) => `<OrderTransaction><Order><OrderID>${orderId}</OrderID><TransactionArray><Transaction><Item><ItemID>${itemId}</ItemID>${note !== undefined ? `<PrivateNotes>${note}</PrivateNotes>` : ''}</Item><TransactionID>${transactionId}</TransactionID></Transaction></TransactionArray></Order></OrderTransaction>`;
const soldList = (rows, totalPages = 1) => `<?xml version="1.0"?><GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><SoldList><OrderTransactionArray>${rows.map(tx).join('')}</OrderTransactionArray><PaginationResult><TotalNumberOfPages>${totalPages}</TotalNumberOfPages></PaginationResult></SoldList></GetMyeBaySellingResponse>`;
const ok = '<?xml version="1.0"?><SetUserNotesResponse><Ack>Success</Ack></SetUserNotesResponse>';
const failure = (msg, code = 21916) => `<?xml version="1.0"?><Response><Ack>Failure</Ack><Errors><ErrorCode>${code}</ErrorCode><ShortMessage>short</ShortMessage><LongMessage>${msg}</LongMessage></Errors></Response>`;
const reset = () => { calls.length = 0; reserved.length = 0; reserveOk = true; exhausted = 0; };
const order = { orderId: '11-12345-67890', itemId: '110001', ordered: true, now: NOW };

(async () => {
  // ---------- what to write ----------
  assert.deepStrictEqual(N.planNote('', true, NOW), { action: 'AddOrUpdate', text: 'ELMS: ordered 27 Sep 2026' });
  assert.deepStrictEqual(N.planNote('call buyer', true, NOW), { action: 'AddOrUpdate', text: 'call buyer | ELMS: ordered 27 Sep 2026' }, "the seller's own text is kept");
  assert.strictEqual(N.planNote('x | ELMS: ordered 1 Jan 2026', true, NOW).action, 'none', 'already there: not added twice');
  assert.strictEqual(N.planNote('a'.repeat(235), true, NOW).text, 'a'.repeat(235) + ' | ELMS: ordered', 'the short mark when the dated one does not fit (255 characters at most)');
  assert.strictEqual(N.planNote('a'.repeat(250), true, NOW).action, 'none'); assert.match(N.planNote('a'.repeat(250), true, NOW).reason, /no room left/);
  assert.ok(N.planNote('a'.repeat(200), true, NOW).text.length <= N.MAX_NOTE);
  assert.deepStrictEqual(N.planNote('call buyer | ELMS: ordered 27 Sep 2026', false), { action: 'AddOrUpdate', text: 'call buyer' }, 'Undo takes out only the mark');
  assert.deepStrictEqual(N.planNote('ELMS: ordered 27 Sep 2026', false), { action: 'Delete' }, 'nothing else left: the note is deleted');
  assert.strictEqual(N.planNote('ELMS: ordered 27 Sep 2026 | call buyer', false).text, 'call buyer');
  assert.strictEqual(N.planNote('a | ELMS: ordered 1 Jan 2026 | b', false).text, 'a | b');
  assert.strictEqual(N.planNote('ELMS: ordered', false).action, 'Delete', 'the short mark too');
  assert.strictEqual(N.planNote('call buyer', false).action, 'none'); assert.strictEqual(N.planNote('', false).action, 'none');

  // ---------- reading eBay's list ----------
  const parsed = N.parseSoldList(soldList([{ orderId: '11-1-1', itemId: '110001', transactionId: '555', note: 'Tom &amp; Jerry &lt;b&gt;' }, { orderId: '22-2-2', itemId: '110002', transactionId: '556' }], 3));
  assert.deepStrictEqual(parsed.lines, [{ orderId: '11-1-1', itemId: '110001', transactionId: '555', note: 'Tom & Jerry <b>' }, { orderId: '22-2-2', itemId: '110002', transactionId: '556', note: '' }], 'entities are read back to text; no note is an empty note');
  assert.strictEqual(parsed.totalPages, 3);
  assert.deepStrictEqual(N.parseSoldList('<x/>'), { lines: [], totalPages: 1 });
  const lines = [{ orderId: '11-1-1', itemId: '9', transactionId: 't1', note: '' }, { orderId: '22-2-2', itemId: '9', transactionId: 't2', note: '' }, { orderId: '33-3-3', itemId: '8', transactionId: 't3', note: '' }, { orderId: '', itemId: '7', transactionId: 't4', note: '' }];
  assert.strictEqual(N.pickLine(lines, { orderId: '22-2-2', itemId: '9' }).line.transactionId, 't2', 'the item AND the order number');
  assert.strictEqual(N.pickLine(lines, { orderId: '99-9-9', itemId: '9' }).reason, 'ambiguous', 'two orders of the item, none is this one: never a guess');
  assert.strictEqual(N.pickLine(lines, { orderId: '99-9-9', itemId: '8' }).reason, 'order_mismatch', 'one order of the item but its number differs: not taken');
  assert.strictEqual(N.pickLine(lines, { orderId: '11-1-1', itemId: '7' }).line.transactionId, 't4', 'eBay gave no order number: the only line of that item');
  assert.strictEqual(N.pickLine(lines, { orderId: '11-1-1', itemId: '1' }).reason, 'not_found');

  // ---------- add: read the note, then write it back with the mark ----------
  reset();
  script = (c, n) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'call buyer' }]) : ok);
  let r = await N.syncOrderNote('rt', 'EBAY_GB', order);
  assert.deepStrictEqual([r.status, r.note], ['written', 'call buyer | ELMS: ordered 27 Sep 2026']);
  assert.deepStrictEqual(calls.map((c) => c.name), ['GetMyeBaySelling', 'SetUserNotes'], 'read first, then write');
  assert.strictEqual(calls[0].url.endsWith('/ws/api.dll'), true); assert.strictEqual(calls[0].headers['X-EBAY-API-IAF-TOKEN'], 'iaf-token'); assert.strictEqual(calls[0].headers['X-EBAY-API-SITEID'], '3', 'the store\'s eBay site');
  assert.ok(calls[0].body.includes('<OrderStatusFilter>AwaitingShipment</OrderStatusFilter>') && calls[0].body.includes('<PageNumber>1</PageNumber>'));
  assert.ok(calls[1].body.includes('<Action>AddOrUpdate</Action>') && calls[1].body.includes('<ItemID>110001</ItemID>') && calls[1].body.includes('<TransactionID>555</TransactionID>') && calls[1].body.includes('<NoteText>call buyer | ELMS: ordered 27 Sep 2026</NoteText>'));
  assert.deepStrictEqual(reserved, [['note', 1], ['note', 1]], 'both calls are taken from eBay\'s daily allowance');
  // special characters in the seller's note are kept, and written back safely
  reset(); script = (c) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'A &amp; B &lt;x&gt;' }]) : ok);
  await N.syncOrderNote('rt', 'EBAY_US', order);
  assert.ok(calls[1].body.includes('<NoteText>A &amp; B &lt;x&gt; | ELMS: ordered 27 Sep 2026</NoteText>'), 'read as A & B <x>, written escaped again: not doubled, not lost');
  // no note yet
  reset(); script = (c) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555' }]) : ok);
  assert.strictEqual((await N.syncOrderNote('rt', 'EBAY_US', order)).note, 'ELMS: ordered 27 Sep 2026');
  // already there: nothing is written
  reset(); script = () => soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'ELMS: ordered 20 Sep 2026' }]);
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'unchanged'); assert.deepStrictEqual(calls.map((c) => c.name), ['GetMyeBaySelling']);

  // ---------- undo ----------
  reset(); script = (c) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'call buyer | ELMS: ordered 27 Sep 2026' }]) : ok);
  r = await N.syncOrderNote('rt', 'EBAY_US', { ...order, ordered: false }); assert.deepStrictEqual([r.status, r.note], ['removed', 'call buyer']); assert.ok(calls[1].body.includes('<NoteText>call buyer</NoteText>'));
  reset(); script = (c) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'ELMS: ordered 27 Sep 2026' }]) : ok);
  r = await N.syncOrderNote('rt', 'EBAY_US', { ...order, ordered: false }); assert.strictEqual(r.status, 'removed');
  assert.ok(calls[1].body.includes('<Action>Delete</Action>') && !calls[1].body.includes('NoteText'), 'a note with nothing else in it is deleted');
  reset(); script = () => soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'mine' }]);
  assert.strictEqual((await N.syncOrderNote('rt', 'EBAY_US', { ...order, ordered: false })).status, 'unchanged', 'no ELMS mark: the seller\'s note is left alone');

  // ---------- finding the order: pages, not found, not certain ----------
  reset(); script = (c, n) => (c.name === 'SetUserNotes' ? ok : n === 1 ? soldList([{ orderId: '00-0-0', itemId: '5', transactionId: '1' }], 2) : soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '777' }], 2));
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'written');
  assert.deepStrictEqual(calls.map((c) => c.name), ['GetMyeBaySelling', 'GetMyeBaySelling', 'SetUserNotes']); assert.ok(calls[1].body.includes('<PageNumber>2</PageNumber>') && calls[2].body.includes('<TransactionID>777</TransactionID>'));
  reset(); script = () => soldList([{ orderId: '00-0-0', itemId: '5', transactionId: '1' }], 1);
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'skipped'); assert.match(r.message, /does not list this order as awaiting shipment/); assert.strictEqual(calls.length, 1);
  reset(); script = () => soldList([{ orderId: '31-1-1', itemId: '110001', transactionId: '1' }, { orderId: '32-2-2', itemId: '110001', transactionId: '2' }]);
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'skipped'); assert.match(r.message, /Nothing was written/); assert.deepStrictEqual(calls.map((c) => c.name), ['GetMyeBaySelling'], 'never a guess');
  reset(); script = () => soldList([], 9);
  await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(calls.length, 3, 'at most 3 pages are read');

  // ---------- when something goes wrong nothing is overwritten ----------
  reset(); script = () => failure('The token is not allowed to read your sales.');
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'failed'); assert.match(r.message, /not allowed to read/); assert.deepStrictEqual(calls.map((c) => c.name), ['GetMyeBaySelling'], 'the note could not be read: nothing is written');
  reset(); script = (c) => (c.name === 'GetMyeBaySelling' ? soldList([{ orderId: '11-12345-67890', itemId: '110001', transactionId: '555', note: 'keep me' }]) : failure('Note text is invalid.'));
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.deepStrictEqual([r.status, r.message], ['failed', 'Note text is invalid.']);
  reset(); script = () => failure('Call usage limit has been reached.', 518);
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'failed'); assert.strictEqual(exhausted, 1, "eBay's own \"limit reached\" stops the day's calls");
  reset(); script = () => { throw Object.assign(new Error('Could not reach eBay.'), { statusCode: 502 }); };
  assert.strictEqual((await N.syncOrderNote('rt', 'EBAY_US', order)).status, 'failed');
  reset(); reserveOk = false; script = () => { throw new Error('must not be called'); };
  r = await N.syncOrderNote('rt', 'EBAY_US', order); assert.strictEqual(r.status, 'skipped'); assert.match(r.message, /daily allowance/); assert.strictEqual(calls.length, 0, 'the budget is used up: no call');
  reset(); assert.strictEqual((await N.syncOrderNote(null, 'EBAY_US', order)).status, 'skipped');
  assert.strictEqual((await N.syncOrderNote('rt', 'EBAY_US', { ...order, itemId: '' })).status, 'skipped'); assert.strictEqual((await N.syncOrderNote('rt', 'EBAY_US', { ...order, orderId: null })).status, 'skipped'); assert.strictEqual(calls.length, 0);

  console.log('ebay order note tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
