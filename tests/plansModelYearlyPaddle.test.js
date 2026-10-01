// The plansModel wrapper around the Plan schema: the yearly term's own Paddle price id threads through
// create/update/serialize, and a lookup by Paddle price id finds a plan by EITHER of its two Paddle prices
// (monthly or yearly - Paddle needs a separate price object per billing period).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const store = new Map();
let seq = 0;
const asDoc = (obj) => ({ ...obj, toObject() { return { ...this }; } });
stub('models/schemas/Plan', {
  create: async (fields) => { const id = 'id' + (seq += 1); const doc = asDoc({ _id: id, active: true, ...fields }); store.set(id, doc); return doc; },
  findByIdAndUpdate: async (id, update) => {
    const doc = store.get(id);
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  findOne: async (filter) => {
    const or = filter.$or || [filter];
    return [...store.values()].find((d) => or.some((cond) => Object.entries(cond).every(([k, v]) => d[k] === v))) || null;
  },
});

const { createPlan, updatePlan, getPlanByPaddlePriceId } = require('../models/plansModel');

(async () => {
  const plan = await createPlan({ name: 'Pro', priceUsd: 120, credits: 6000, paddlePriceId: 'pri_month', yearlyPriceUsd: 1200, paddleYearlyPriceId: 'pri_year' });
  assert.strictEqual(plan.paddleYearlyPriceId, 'pri_year');

  assert.strictEqual((await getPlanByPaddlePriceId('pri_month')).id, plan.id, 'found by its monthly Paddle price');
  assert.strictEqual((await getPlanByPaddlePriceId('pri_year')).id, plan.id, 'found by its yearly Paddle price');
  assert.strictEqual(await getPlanByPaddlePriceId('pri_unknown'), null);

  const updated = await updatePlan(plan.id, { paddleYearlyPriceId: 'pri_year_2' });
  assert.strictEqual(updated.paddleYearlyPriceId, 'pri_year_2');
  assert.strictEqual((await getPlanByPaddlePriceId('pri_year_2')).id, plan.id);
  assert.strictEqual(await getPlanByPaddlePriceId('pri_year'), null, 'the old yearly price id no longer matches');

  const cleared = await updatePlan(plan.id, { paddleYearlyPriceId: '' });
  assert.strictEqual(cleared.paddleYearlyPriceId, null, 'empty switches the yearly Paddle option off');

  // a plan with no yearly Paddle price at all is unaffected - only its monthly price matches
  const monthlyOnly = await createPlan({ name: 'Starter', priceUsd: 10, credits: 500, paddlePriceId: 'pri_starter' });
  assert.strictEqual(monthlyOnly.paddleYearlyPriceId, null);
  assert.strictEqual((await getPlanByPaddlePriceId('pri_starter')).id, monthlyOnly.id);

  console.log('plansModel yearly Paddle tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
