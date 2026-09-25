// Watchers for a whole store come from ONE eBay call for 200 listings (GetMyeBaySelling), not one call per listing.
// The request, the answer's parsing and what a "call limit reached" answer does are checked here; the eBay call itself is a stub.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const usageWrites = [];
stub('models/schemas/ApiUsage', { updateOne: async (filter, update) => { usageWrites.push(update); }, findOne: () => ({ lean: async () => null }) });
stub('services/ebayAuthService', { getAccessToken: async () => 'access-token' });

const axios = require('axios');
const sent = [];
let answer = '';
axios.post = async (url, body, opts) => { sent.push({ url, body, headers: opts.headers }); return { data: answer }; };

const { fetchActiveListingStats, parseActiveListStats, fetchItemTraffic } = require('../services/ebayStatsService');

const SUCCESS = `<?xml version="1.0"?><GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><ActiveList>
<ItemArray>
  <Item><ItemID>1001</ItemID><WatchCount>4</WatchCount><HitCount>120</HitCount></Item>
  <Item><ItemID>1002</ItemID></Item>
  <Item><ItemID>1003</ItemID><WatchCount>0</WatchCount></Item>
</ItemArray>
<PaginationResult><TotalNumberOfPages>3</TotalNumberOfPages><TotalNumberOfEntries>540</TotalNumberOfEntries></PaginationResult>
</ActiveList></GetMyeBaySellingResponse>`;

(async () => {
  // ---------- parsing ----------
  const parsed = parseActiveListStats(SUCCESS);
  assert.deepStrictEqual(parsed.items, [
    { itemId: '1001', watchers: 4, views: 120 },
    { itemId: '1002', watchers: 0, views: null }, // no WatchCount = nobody watches; no HitCount = eBay did not say
    { itemId: '1003', watchers: 0, views: null },
  ]);
  assert.strictEqual(parsed.totalPages, 3);
  assert.deepStrictEqual(parseActiveListStats('<GetMyeBaySellingResponse><Ack>Success</Ack></GetMyeBaySellingResponse>'), { items: [], totalPages: 1 }, 'a seller with nothing live');
  assert.strictEqual(parseActiveListStats('<ItemArray><Item><WatchCount>5</WatchCount></Item></ItemArray>').items.length, 0, 'an entry without an item id is ignored');

  // ---------- the request: one call, 200 listings, only the fields that are needed ----------
  answer = SUCCESS;
  const got = await fetchActiveListingStats('refresh', 'EBAY_GB', 2);
  assert.strictEqual(got.items.length, 3);
  assert.strictEqual(sent.length, 1, 'one eBay call for the page');
  assert.match(sent[0].url, /\/ws\/api\.dll$/);
  assert.strictEqual(sent[0].headers['X-EBAY-API-CALL-NAME'], 'GetMyeBaySelling');
  assert.strictEqual(sent[0].headers['X-EBAY-API-SITEID'], '3', 'the seller\'s marketplace is the site (EBAY_GB = 3)');
  assert.strictEqual(sent[0].headers['X-EBAY-API-IAF-TOKEN'], 'access-token');
  assert.match(sent[0].body, /<EntriesPerPage>200<\/EntriesPerPage>/, '200 listings per call');
  assert.match(sent[0].body, /<PageNumber>2<\/PageNumber>/);
  assert.match(sent[0].body, /<ActiveList>\s*<Include>true<\/Include>/);
  for (const field of ['ItemID', 'WatchCount', 'HitCount']) assert.ok(sent[0].body.includes('<OutputSelector>ActiveList.ItemArray.Item.' + field + '</OutputSelector>'), field + ' is asked for');
  await fetchActiveListingStats('refresh', 'EBAY_US', 'nonsense');
  assert.match(sent[1].body, /<PageNumber>1<\/PageNumber>/, 'a bad page number becomes page 1');

  // ---------- failures ----------
  usageWrites.length = 0;
  answer = '<Ack>Failure</Ack><Errors><ErrorCode>17</ErrorCode><LongMessage>The item cannot be accessed.</LongMessage></Errors>';
  await assert.rejects(() => fetchActiveListingStats('refresh', 'EBAY_US'), (err) => err.message === 'The item cannot be accessed.' && err.limitReached === false && err.statusCode === 502);
  assert.strictEqual(usageWrites.filter((u) => u.$set && u.$set.exhausted).length, 0, 'an ordinary failure does not stop the day');

  answer = '<Ack>Failure</Ack><Errors><ErrorCode>518</ErrorCode><LongMessage>Call usage limit has been reached.</LongMessage></Errors>';
  await assert.rejects(() => fetchActiveListingStats('refresh', 'EBAY_US'), (err) => err.limitReached === true);
  assert.ok(usageWrites.some((u) => u.$set && u.$set.exhausted === true), 'a limit answer stops today\'s statistics');
  // the single-listing read reports the limit the same way
  usageWrites.length = 0;
  await assert.rejects(() => fetchItemTraffic('refresh', '1001', 'EBAY_US'), (err) => err.limitReached === true);
  assert.ok(usageWrites.some((u) => u.$set && u.$set.exhausted === true));

  axios.post = async () => { throw new Error('socket hang up'); };
  await assert.rejects(() => fetchActiveListingStats('refresh', 'EBAY_US'), (err) => err.message === 'Could not reach eBay to read listing traffic.' && err.statusCode === 502);

  // ---------- the one-listing read is counted; a read the caller already reserved is not counted twice ----------
  axios.post = async () => ({ data: '<Ack>Success</Ack><Item><WatchCount>2</WatchCount><HitCount>30</HitCount></Item>' });
  usageWrites.length = 0;
  assert.deepStrictEqual(await fetchItemTraffic('refresh', '1001', 'EBAY_US'), { watchers: 2, views: 30 });
  assert.strictEqual(usageWrites.length, 1, 'a one-off read counts itself');
  usageWrites.length = 0;
  await fetchItemTraffic('refresh', '1001', 'EBAY_US', { counted: true });
  assert.strictEqual(usageWrites.length, 0, 'a reserved read is not counted again');

  console.log('bulk stats: all good');
})().catch((err) => { console.error(err); process.exit(1); });
