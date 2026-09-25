// /api/pricing: the seller's rule can be read, saved (bad values are refused, never corrected) and previewed with the same function that prices an import.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let stored = null;
const saves = [];
stub('models/usersModel', { getPricingRule: async () => stored, setPricingRule: async (userId, rule) => { saves.push(rule); stored = rule; return rule; } });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
const router = require('../routes/pricing');
const P = require('../services/pricingService');

const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (method, p, body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await handler(method, p)({ userId: 'u1', body: body || {} }, res); return res; };

(async () => {
  // ---------- read ----------
  let res = await call('get', '/rule');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.isSet, false);
  assert.strictEqual(res.body.rule.enabled, false, 'never set: the defaults, switched off');
  assert.strictEqual(res.body.rule.feePercent, 13); assert.strictEqual(res.body.rule.feeFixed, 0.3);
  assert.strictEqual(res.body.limits.feePercent.max, 60);
  assert.strictEqual(res.body.maxTiers, 10);

  // ---------- save ----------
  res = await call('put', '/rule', { enabled: true, currency: 'gbp', feePercent: '13', feeFixed: '0.30', profitPercent: 10, profitFixed: 0.3, minProfit: '', centsEnding: '99', tiers: [] });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([res.body.rule.enabled, res.body.rule.currency, res.body.rule.feePercent, res.body.rule.centsEnding, res.body.rule.minProfit], [true, 'GBP', 13, 99, 0], 'saved cleaned');
  assert.strictEqual(saves.length, 1);
  res = await call('get', '/rule');
  assert.deepStrictEqual([res.body.isSet, res.body.rule.profitPercent], [true, 10]);

  // bad values: refused with the reason, nothing saved
  for (const [body, re] of [[{ feePercent: 70 }, /Fees %/], [{ profitPercent: -5 }, /Profit %/], [{ centsEnding: 150 }, /cents value/], [{ currency: 'XX' }, /currency/], [{ tiers: [{ from: 5, to: 1, profitPercent: 3 }] }, /"to"/]]) {
    const before = saves.length;
    res = await call('put', '/rule', body);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, re);
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length >= 1);
    assert.strictEqual(saves.length, before, 'nothing saved for ' + JSON.stringify(body));
  }
  res = await call('put', '/rule', { feePercent: 70, profitPercent: 5000 });
  assert.strictEqual(res.body.errors.length, 2, 'every problem is reported, the first one is the message');

  // ---------- preview: the seller's own example ----------
  res = await call('post', '/preview', { cost: 142.19, rule: { enabled: false, feePercent: 13, feeFixed: 0.3, profitPercent: 10, profitFixed: 0.3 } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([res.body.breakdown.price, res.body.breakdown.fees, res.body.breakdown.profit], [180.47, 23.46, 14.52], 'a rule that is not saved (and switched off) can be tried');
  assert.deepStrictEqual(res.body.breakdown, P.computePrice(142.19, P.normalizeRule({ feePercent: 13, feeFixed: 0.3, profitPercent: 10, profitFixed: 0.3 }).rule), 'the same function as an import');
  // no rule sent: the saved one
  stored = P.normalizeRule({ enabled: true, feePercent: 10, feeFixed: 0, profitPercent: 20, profitFixed: 0 }).rule;
  res = await call('post', '/preview', { cost: 10 });
  assert.strictEqual(res.body.breakdown.price, 13.33); // 10 x 1.2 / 0.9
  // never saved and none sent: the defaults
  stored = null;
  res = await call('post', '/preview', { cost: 10 });
  assert.strictEqual(res.body.breakdown.price, P.computePrice(10, P.normalizeRule(P.DEFAULT_RULE).rule).price);
  // bad input
  for (const cost of [0, -1, 'abc', undefined, null]) { res = await call('post', '/preview', { cost }); assert.strictEqual(res.statusCode, 400, String(cost)); assert.match(res.body.error, /costs/); }
  res = await call('post', '/preview', { cost: 10, rule: { feePercent: 99 } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /Fees %/);
  res = await call('post', '/preview', { cost: 10, rule: { tiers: [{ from: 0, to: 10, profitPercent: 10 }, { from: 5, to: 20, profitPercent: 20 }] } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /overlap/);
  stored = { feePercent: 500 }; // a corrupt saved rule
  res = await call('post', '/preview', { cost: 10 });
  assert.strictEqual(res.statusCode, 400);

  console.log('pricing routes: all good');
})().catch((err) => { console.error(err); process.exit(1); });
