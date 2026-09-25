// The pricing rule is money: the formula, the cents, the limits and the tiers are checked here, including the seller's own example.
const assert = require('assert');
const P = require('../services/pricingService');

const rule = (over = {}) => ({ ...P.DEFAULT_RULE, enabled: true, feePercent: 13, feeFixed: 0.3, profitPercent: 10, profitFixed: 0.3, ...over });
const sum = (x) => Number((x.costTotal + x.fees + x.feeFixed + x.profit).toFixed(2));

// ---------- the example the seller gave: cost 142.19, profit 10% + 0.30, fees 13% + 0.30 -> 180.47 ----------
let r = P.computePrice(142.19, rule());
assert.strictEqual(r.price, 180.47, 'total price');
assert.strictEqual(r.fees, 23.46, '13% of the price');
assert.strictEqual(r.profit, 14.52, '10% of the cost + 0.30, less the rounding');
assert.strictEqual(r.feeFixed, 0.3);
assert.strictEqual(r.costTotal, 142.19);
assert.strictEqual(r.markupPercent, 26.92);
assert.ok(!r.minProfitApplied && !r.endingApplied && r.tier === null);
assert.strictEqual(sum(r), r.price, 'the parts add up to the price to the cent');

// ---------- the calculator's default: cost 10, 13% + 0.30, 30% profit ----------
r = P.computePrice(10, rule({ profitPercent: 30, profitFixed: 0 }));
assert.strictEqual(r.price, 15.29); // (10 x 1.3 + 0.30) / 0.87 = 15.287
assert.strictEqual(sum(r), r.price);

// ---------- the parts always add up, whatever the numbers (a lot of random rules and costs) ----------
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < 3000; i += 1) {
  const rl = rule({
    feePercent: Math.round(rnd() * 5000) / 100, feeFixed: Math.round(rnd() * 200) / 100, profitPercent: Math.round(rnd() * 20000) / 100,
    profitFixed: Math.round(rnd() * 500) / 100, shipping: Math.round(rnd() * 800) / 100,
    minProfit: rnd() < 0.5 ? Math.round(rnd() * 900) / 100 : 0, centsEnding: rnd() < 0.5 ? Math.floor(rnd() * 100) : null,
  });
  const cost = Math.round((0.5 + rnd() * 900) * 100) / 100;
  const x = P.computePrice(cost, rl);
  const why = JSON.stringify({ cost, rl, x });
  assert.ok(x, 'priced ' + why);
  assert.strictEqual(sum(x), x.price, 'parts add up: ' + why);
  assert.ok(x.price > x.costTotal, 'the price is above the cost: ' + why);
  assert.ok(x.profit >= -0.02, 'never a loss (a cent or two of rounding at most): ' + why);
  if (rl.minProfit > 0) assert.ok(x.profit >= rl.minProfit - 0.005, 'minimum profit is kept: ' + why);
  if (rl.centsEnding !== null) assert.strictEqual(Math.round(x.price * 100) % 100, rl.centsEnding, 'ends in the chosen cents: ' + why);
}

// ---------- shipping is part of the cost ----------
r = P.computePrice(10, rule({ profitPercent: 20, profitFixed: 0, feeFixed: 0, feePercent: 10, shipping: 5 }));
assert.strictEqual(r.costTotal, 15);
assert.strictEqual(r.price, 20); // 15 x 1.2 / 0.9
assert.strictEqual(r.shipping, 5);

// ---------- price cents ----------
const plain = { profitPercent: 0, profitFixed: 0, feeFixed: 0, feePercent: 0 };
const ending = (cost, e) => P.computePrice(cost, rule({ ...plain, centsEnding: e })).price;
assert.strictEqual(ending(12.34, 99), 12.99, 'up to the next .99');
assert.strictEqual(ending(12.99, 99), 12.99, 'already .99: unchanged');
assert.strictEqual(ending(13.0, 99), 13.99);
assert.strictEqual(ending(12.34, 0), 13, 'a whole number, rounded up');
assert.strictEqual(ending(12.0, 0), 12);
assert.strictEqual(ending(12.51, 95), 12.95);
assert.strictEqual(ending(0.5, 99), 0.99);
assert.strictEqual(P.computePrice(12.34, rule({ ...plain, centsEnding: 99 })).endingApplied, true);
assert.strictEqual(P.computePrice(12.99, rule({ ...plain, centsEnding: 99 })).endingApplied, false);

// ---------- minimum profit only raises the price ----------
r = P.computePrice(10, rule({ profitPercent: 1, profitFixed: 0, feeFixed: 0.3, feePercent: 13, minProfit: 3 }));
assert.ok(r.minProfitApplied);
assert.ok(r.profit >= 3);
r = P.computePrice(100, rule({ profitPercent: 50, profitFixed: 0, minProfit: 3 }));
assert.ok(!r.minProfitApplied, 'already above the minimum: nothing changes');
assert.strictEqual(r.price, P.computePrice(100, rule({ profitPercent: 50, profitFixed: 0, minProfit: 0 })).price);

// ---------- dynamic profit (ranges of the cost) ----------
const tiered = rule({ profitPercent: 10, profitFixed: 0, feeFixed: 0, feePercent: 0, tiers: [{ from: 0, to: 10, profitPercent: 100, profitFixed: 1 }, { from: 10, to: 50, profitPercent: 50, profitFixed: 0 }, { from: 50, to: null, profitPercent: 20, profitFixed: 0 }] });
assert.strictEqual(P.computePrice(5, tiered).price, 11, '5 x 2 + 1 (first range)');
assert.strictEqual(P.computePrice(10, tiered).price, 15, '10 is in the second range (from is included)');
assert.strictEqual(P.computePrice(50, tiered).price, 60);
assert.strictEqual(P.computePrice(500, tiered).price, 600, 'no upper limit');
assert.strictEqual(P.computePrice(5, tiered).tier.index, 0);
assert.strictEqual(P.computePrice(10, rule({ ...tiered, tiers: [{ from: 20, to: 30, profitPercent: 90, profitFixed: 0 }] })).tier, null, 'a cost outside every range uses the normal profit');

// ---------- a product that cannot be priced is not priced ----------
for (const bad of [0, -3, null, undefined, 'abc', NaN, Infinity, 5e9]) assert.strictEqual(P.computePrice(bad, rule()), null, String(bad));
assert.strictEqual(P.computePrice(10, null), null);
assert.strictEqual(P.computePrice(10, rule({ feePercent: 100 })), null, 'fees of 100% leave nothing to divide by');

// ---------- checking what someone types: nothing is fixed silently ----------
const ok = (input) => { const x = P.normalizeRule(input); assert.deepStrictEqual(x.errors, [], JSON.stringify(input)); return x.rule; };
const bad = (input, re) => { const x = P.normalizeRule(input); assert.strictEqual(x.rule, null); assert.ok(x.errors.length, JSON.stringify(input)); assert.match(x.errors.join(' | '), re); };
assert.deepStrictEqual(ok({}), { ...P.DEFAULT_RULE, tiers: [] }, 'an empty rule is the defaults, switched off');
let n = ok({ enabled: true, currency: 'gbp', feePercent: '13', feeFixed: '0.30', profitPercent: '10', profitFixed: 0.3, minProfit: '', shipping: null, centsEnding: '99' });
assert.deepStrictEqual([n.enabled, n.currency, n.feePercent, n.feeFixed, n.profitPercent, n.profitFixed, n.minProfit, n.shipping, n.centsEnding], [true, 'GBP', 13, 0.3, 10, 0.3, 0, 0, 99]);
assert.strictEqual(ok({ enabled: 'true' }).enabled, true);
assert.strictEqual(ok({ enabled: 1 }).enabled, false, 'only true switches it on');
bad({ feePercent: 61 }, /Fees %/); bad({ feePercent: -1 }, /Fees %/); bad({ feePercent: 'x' }, /Fees %/);
bad({ profitPercent: 1001 }, /Profit %/); bad({ profitFixed: -0.01 }, /Fixed profit/); bad({ feeFixed: 10001 }, /Fixed fee/);
bad({ minProfit: 'abc' }, /Minimum profit/); bad({ shipping: -5 }, /Shipping price/);
bad({ currency: 'POUNDS' }, /currency/); bad({ centsEnding: 100 }, /cents value/); bad({ centsEnding: 9.5 }, /cents value/); bad({ centsEnding: -1 }, /cents value/);
assert.strictEqual(ok({ centsEnding: 0 }).centsEnding, 0, '.00 is a real choice');
assert.strictEqual(ok({ centsEnding: '' }).centsEnding, null);
bad({ tiers: 'x' }, /must be a list/);
bad({ tiers: Array.from({ length: 11 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, profitPercent: 10 })) }, /at most 10/);
bad({ tiers: [{ from: 10, to: 5, profitPercent: 10 }] }, /"to" must be more than "from"/);
bad({ tiers: [{ from: -1, to: 5, profitPercent: 10 }] }, /"from"/);
bad({ tiers: [{ from: 0, to: 5 }] }, /profit %/);
bad({ tiers: [{ from: 0, to: 10, profitPercent: 10 }, { from: 5, to: 20, profitPercent: 20 }] }, /overlap/);
bad({ tiers: [{ from: 0, to: null, profitPercent: 10 }, { from: 5, to: 20, profitPercent: 20 }] }, /overlap/);
n = ok({ tiers: [{ from: 50, to: null, profitPercent: 20 }, { from: 0, to: 50, profitPercent: '40', profitFixed: '' }] });
assert.deepStrictEqual(n.tiers, [{ from: 0, to: 50, profitPercent: 40, profitFixed: 0 }, { from: 50, to: null, profitPercent: 20, profitFixed: 0 }], 'sorted, cleaned');
assert.strictEqual(P.normalizeRule(null).rule.enabled, false);

// ---------- a rule in another currency: only the money moves ----------
const gbp = rule({ currency: 'GBP', feeFixed: 0.3, profitFixed: 1, minProfit: 2, shipping: 3, tiers: [{ from: 0, to: 10, profitPercent: 50, profitFixed: 1 }] });
const usd = P.ruleInCurrency(gbp, 'USD', 1.25);
assert.deepStrictEqual([usd.currency, usd.feeFixed, usd.profitFixed, usd.minProfit, usd.shipping], ['USD', 0.38, 1.25, 2.5, 3.75]);
assert.deepStrictEqual(usd.tiers, [{ from: 0, to: 12.5, profitPercent: 50, profitFixed: 1.25 }]);
assert.strictEqual(usd.feePercent, 13);
assert.strictEqual(usd.profitPercent, 10, 'percentages do not change');
assert.strictEqual(P.ruleInCurrency(gbp, 'GBP', 999).feeFixed, 0.3, 'same currency: the rate is not used');
assert.strictEqual(P.ruleInCurrency(rule({ currency: null }), 'USD', 999).feeFixed, 0.3, "a rule with no currency is taken to be in the product's");
assert.throws(() => P.ruleInCurrency(gbp, 'USD', undefined), /exchange rate/);
assert.throws(() => P.ruleInCurrency(gbp, 'USD', 0), /exchange rate/);
assert.strictEqual(gbp.feeFixed, 0.3, 'the original is not changed');

assert.strictEqual(P.roundUpToEnding(1234, 99), 1299);
assert.strictEqual(P.roundUpToEnding(1299, 99), 1299);
assert.strictEqual(P.roundUpToEnding(50, 99), 99);
console.log('pricing rule: all good');
