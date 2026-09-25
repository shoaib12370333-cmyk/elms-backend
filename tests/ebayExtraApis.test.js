// Three eBay APIs ELMS did not use before, all read-only: the application's own call counts (Analytics getRateLimits, app token), the seller's
// selling limit (Account getPrivileges) and listings that break an eBay rule (Compliance). The payloads are shaped like eBay's documentation.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- what eBay "answers" ----
const asked = [];
let answers = {};
stub('services/ebayRestClient', {
  ebayUserGet: async (token, url, opts) => { asked.push({ kind: 'user', token, url, opts }); const a = answers[url.split('?')[0]]; if (a instanceof Error) throw a; return a; },
  ebayAppGet: async (url) => { asked.push({ kind: 'app', url }); const a = answers[url]; if (a instanceof Error) throw a; return a; },
});
let ownListings = [];
stub('models/schemas/Listing', { find: (f) => { const q = { select: () => q, lean: async () => ownListings.filter((l) => f.ebayListingId.$in.includes(l.ebayListingId)) }; return q; } });
const err = (status, message) => Object.assign(new Error(message), { statusCode: status });

const { parseRateLimits, fetchRateLimits, clearRateLimitCache } = require('../services/ebayRateLimitService');
const status = require('../services/ebayAccountStatusService');

const RATE_LIMITS = { rateLimits: [
  { apiContext: 'sell', apiName: 'Fulfillment', apiVersion: 'v1', resources: [{ name: 'sell.fulfillment', rates: [{ count: 250, limit: 100000, remaining: 99750, reset: '2026-09-27T07:00:00.000Z', timeWindow: 86400 }] }] },
  { apiContext: 'tradingapi', apiName: 'TradingAPI', apiVersion: 'v1', resources: [{ name: 'GetItem', rates: [{ count: 4100, limit: 5000, remaining: 900, reset: '2026-09-27T07:00:00.000Z', timeWindow: 86400 }] }] },
  { apiContext: 'commerce', apiName: 'Taxonomy', apiVersion: 'v1', resources: [{ name: 'commerce.taxonomy', rates: [{ limit: 5000, remaining: 4990, timeWindow: 86400 }] }] },
  { apiContext: 'buy', apiName: 'Browse', apiVersion: 'v1', resources: [{ name: 'buy.browse', rates: [{ count: 0, limit: 0, remaining: 0 }] }] }, // no limit: not shown
] };

(async () => {
  // ---------- rate limits ----------
  let rows = parseRateLimits(RATE_LIMITS);
  assert.deepStrictEqual(rows.map((r) => r.apiName), ['TradingAPI', 'Fulfillment', 'Taxonomy'], 'busiest first; a row without a limit is left out');
  assert.deepStrictEqual([rows[0].used, rows[0].limit, rows[0].remaining, rows[0].percent, rows[0].apiContext, rows[0].windowSeconds], [4100, 5000, 900, 82, 'tradingapi', 86400]);
  assert.strictEqual(rows[2].used, 10, 'no count from eBay: used = limit - remaining');
  assert.strictEqual(rows[2].count, null);
  assert.strictEqual(rows[1].percent, 0);
  assert.deepStrictEqual(parseRateLimits({}), []); assert.deepStrictEqual(parseRateLimits(null), []);
  assert.strictEqual(parseRateLimits({ rateLimits: [{ apiName: 'X', resources: [{ name: 'r', rates: [{ count: 9, limit: 5, remaining: 0 }] }] }] })[0].percent, 100, 'never above 100%');

  answers['/developer/analytics/v1_beta/rate_limit/'] = RATE_LIMITS;
  clearRateLimitCache(); asked.length = 0;
  rows = await fetchRateLimits();
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(asked.map((a) => a.kind), ['app'], 'asked as the application, not as a seller');
  await fetchRateLimits();
  assert.strictEqual(asked.length, 1, 'remembered for a minute');
  await fetchRateLimits({ force: true });
  assert.strictEqual(asked.length, 2, 'refresh asks again');

  // ---------- selling limit ----------
  assert.deepStrictEqual(status.parsePrivileges({ sellingLimit: { amount: { value: '100.0', currency: 'GBP' }, quantity: 10 }, sellerRegistrationCompleted: true }),
    { registrationCompleted: true, sellingLimit: { quantity: 10, amount: { value: 100, currency: 'GBP' } } });
  assert.deepStrictEqual(status.parsePrivileges({ sellerRegistrationCompleted: false }), { registrationCompleted: false, sellingLimit: null }, 'no cap = no selling limit');
  assert.deepStrictEqual(status.parsePrivileges({ sellingLimit: { quantity: 5 } }), { registrationCompleted: null, sellingLimit: { quantity: 5, amount: null } });
  assert.deepStrictEqual(status.parsePrivileges(undefined), { registrationCompleted: null, sellingLimit: null });

  // ---------- violations ----------
  const summary = status.parseViolationSummary({ violationSummaries: [
    { complianceType: 'HTTPS', marketplaceId: 'EBAY_GB', listingCount: 2 },
    { complianceType: 'ASPECTS_ADOPTION', marketplaceId: 'EBAY_GB', listingCount: 7 },
    { complianceType: 'PRODUCT_ADOPTION', marketplaceId: 'EBAY_GB', listingCount: 0 },
  ] });
  assert.strictEqual(summary.total, 9);
  assert.deepStrictEqual(summary.byType.map((s) => s.complianceType), ['ASPECTS_ADOPTION', 'HTTPS'], 'biggest first, zero counts left out');
  assert.strictEqual(summary.byType[0].label, 'Missing or invalid item specifics');
  assert.strictEqual(status.complianceLabel('SOME_NEW_RULE'), 'Some new rule', 'a type ELMS does not know yet is still readable');
  assert.deepStrictEqual(status.parseViolationSummary({}), { total: 0, byType: [] });

  const list = status.parseViolations({ total: 2, listingViolations: [
    { listingId: '111', complianceType: 'ASPECTS_ADOPTION', sku: 'B0AAA', violations: [{ reasonCode: 'ASPECTS_MISSING', message: 'Brand is missing.' }, { reasonCode: 'X' }] },
    { complianceType: 'HTTPS' },
  ] });
  assert.strictEqual(list.length, 1, 'an entry without a listing id is ignored');
  assert.deepStrictEqual(list[0].violations, [{ reasonCode: 'ASPECTS_MISSING', message: 'Brand is missing.' }, { reasonCode: 'X', message: 'X' }]);

  // ---------- one store's status ----------
  const PRIV = '/sell/account/v1/privilege';
  const SUMMARY = '/sell/compliance/v1/listing_violation_summary';
  answers = { [PRIV]: { sellingLimit: { amount: { value: '500', currency: 'GBP' }, quantity: 20 }, sellerRegistrationCompleted: true }, [SUMMARY]: { violationSummaries: [{ complianceType: 'ASPECTS_ADOPTION', marketplaceId: 'EBAY_GB', listingCount: 3 }] } };
  status.clearStatusCache(); asked.length = 0;
  let s = await status.getAccountStatus('A1', 'rt', 'EBAY_GB');
  assert.deepStrictEqual([s.sellingLimit.quantity, s.sellingLimit.amount.currency, s.registrationCompleted, s.violations.total, s.errors], [20, 'GBP', true, 3, {}]);
  assert.deepStrictEqual(asked.map((a) => a.token), ['rt', 'rt'], 'as the seller');
  assert.ok(asked.every((a) => a.opts.marketplaceId === 'EBAY_GB'));
  await status.getAccountStatus('A1', 'rt', 'EBAY_GB');
  assert.strictEqual(asked.length, 2, 'remembered for 30 minutes');

  // "refresh now" is honoured only after a minute
  const realNow = Date.now;
  Date.now = () => realNow() + 30 * 1000;
  await status.getAccountStatus('A1', 'rt', 'EBAY_GB', { refresh: true });
  assert.strictEqual(asked.length, 2, 'a refresh 30 seconds later is ignored');
  Date.now = () => realNow() + 90 * 1000;
  await status.getAccountStatus('A1', 'rt', 'EBAY_GB', { refresh: true });
  assert.strictEqual(asked.length, 4, 'a refresh after a minute asks eBay again');
  Date.now = () => realNow() + 31 * 60 * 1000 + 91 * 1000;
  await status.getAccountStatus('A1', 'rt', 'EBAY_GB');
  assert.strictEqual(asked.length, 6, 'after 30 minutes it asks again by itself');
  Date.now = realNow;

  // each part fails on its own
  status.clearStatusCache();
  answers = { [PRIV]: err(403, 'Insufficient permissions'), [SUMMARY]: { violationSummaries: [] } };
  s = await status.getAccountStatus('A2', 'rt', 'EBAY_US');
  assert.strictEqual(s.sellingLimit, null); assert.strictEqual(s.violations.total, 0);
  assert.match(s.errors.privileges, /Reconnecting the store/); assert.ok(!s.errors.compliance);
  answers = { [PRIV]: { sellerRegistrationCompleted: true }, [SUMMARY]: err(500, 'eBay is having a problem') };
  s = await status.getAccountStatus('A3', 'rt', 'EBAY_US');
  assert.strictEqual(s.violations, null); assert.strictEqual(s.errors.compliance, 'eBay is having a problem'); assert.strictEqual(s.registrationCompleted, true);

  // ---------- the listings behind one rule ----------
  asked.length = 0;
  answers = { '/sell/compliance/v1/listing_violation': { total: 2, listingViolations: [
    { listingId: '111', complianceType: 'ASPECTS_ADOPTION', violations: [{ reasonCode: 'A', message: 'Brand is missing.' }] },
    { listingId: '222', complianceType: 'ASPECTS_ADOPTION', sku: 'B0BBB', violations: [] },
  ] } };
  ownListings = [{ ebayListingId: '111', title: 'Blue mug', sku: 'B0AAA' }];
  const v = await status.getViolations('u1', 'A1', 'rt', 'EBAY_GB', 'ASPECTS_ADOPTION');
  assert.strictEqual(v.total, 2);
  assert.deepStrictEqual(v.listings.map((l) => [l.listingId, l.title, l.sku]), [['111', 'Blue mug', 'B0AAA'], ['222', null, 'B0BBB']], 'ELMS titles are added where the listing is known');
  assert.match(asked[0].url, /compliance_type=ASPECTS_ADOPTION&limit=200/);
  assert.strictEqual(asked[0].opts.marketplaceId, 'EBAY_GB', 'eBay wants the marketplace for this call');
  asked.length = 0;
  await status.getViolations('u1', 'A1', 'rt', 'EBAY_GB', 'aspects&x=1;drop');
  assert.ok(/compliance_type=A[A-Z_]*&limit/.test(asked[0].url) && !/[;&]x=1/.test(asked[0].url), 'the type is cleaned before it goes into the address');
  await assert.rejects(() => status.getViolations('u1', 'A1', 'rt', 'EBAY_GB', ''), (e) => e.statusCode === 400);

  // ---------- the routes ----------
  const noop = async () => null;
  let account = { id: 'A1', marketplaceId: 'EBAY_GB' };
  let token = 'rt';
  const fakes = {
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../models/ebayAccountsModel': { listEbayAccounts: noop, getAccountLimitStatus: noop, setActiveEbayAccount: noop, updateEbayAccountDisplayName: noop, getEbayAccountById: async (u, id) => (id === 'A1' ? account : null), getEbayAccountRefreshToken: async () => token },
    '../services/accountIdentityService': { refreshStaleIdentities: noop, refreshAccountIdentity: noop },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]ebayAccounts\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/ebayAccounts');
  Module._load = orig;
  const handlerOf = (p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods.get); return l.route.stack[l.route.stack.length - 1].handle; };
  const call = async (h, params, query) => { const out = {}; const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; if (!out.status) out.status = 200; return this; } }; await h({ userId: 'u1', params, query: query || {}, body: {} }, res); return out; };

  status.clearStatusCache();
  answers = { [PRIV]: { sellingLimit: { quantity: 10 } }, [SUMMARY]: { violationSummaries: [] } };
  let out = await call(handlerOf('/:id/status'), { id: 'A1' });
  assert.deepStrictEqual([out.status, out.body.success, out.body.status.sellingLimit.quantity], [200, true, 10]);
  out = await call(handlerOf('/:id/status'), { id: 'NOPE' });
  assert.strictEqual(out.status, 404);
  token = null;
  out = await call(handlerOf('/:id/status'), { id: 'A1' });
  assert.deepStrictEqual([out.status, /disconnected/.test(out.body.error)], [400, true]);
  out = await call(handlerOf('/:id/violations'), { id: 'A1' }, { type: 'HTTPS' });
  assert.strictEqual(out.status, 400);
  token = 'rt';
  answers = { '/sell/compliance/v1/listing_violation': { total: 0, listingViolations: [] } };
  out = await call(handlerOf('/:id/violations'), { id: 'A1' }, { type: 'HTTPS' });
  assert.deepStrictEqual([out.status, out.body.total, out.body.listings], [200, 0, []]);
  out = await call(handlerOf('/:id/violations'), { id: 'A1' }, {});
  assert.strictEqual(out.status, 400, 'no type = 400');
  out = await call(handlerOf('/:id/violations'), { id: 'NOPE' }, { type: 'HTTPS' });
  assert.strictEqual(out.status, 404);

  console.log('extra eBay APIs: all good');
})().catch((e) => { console.error(e); process.exit(1); });
