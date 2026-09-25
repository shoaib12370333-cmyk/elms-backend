// The pricing rule in the imports: a rule that is switched on prices a product when no markup % came with it, in the single import, the
// extension's import and the background list; a markup % typed always wins and works as it always did; a rule that cannot be used saves
// nothing and costs nothing; a draft keeps the rule it was priced with, a hand-typed price ends it, and a re-pricing follows it.
// The real routes, services and job run here; the database, the exchange rates and eBay are stand-ins.
const assert = require('assert');
const path = require('path');
process.env.EASYPARSER_API_KEY = 'test-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const settingsDoc = { key: 'global' };
stub('models/schemas/Settings', {
  findOne: () => { const p = Promise.resolve({ toObject: () => ({ ...settingsDoc }) }); p.lean = async () => ({ ...settingsDoc }); return p; },
  create: async () => ({ toObject: () => ({ ...settingsDoc }) }),
  findOneAndUpdate: async (q, update) => { Object.assign(settingsDoc, update); return { toObject: () => ({ ...settingsDoc }) }; },
});

const db = { balance: 50, spent: [], drafts: [], jobs: [], ruleReads: 0 };
let storedRule = null;
let rates = { 'USD>GBP': 0.8 };
let fxDown = false;
stub('models/usersModel', {
  getPricingRule: async () => { db.ruleReads += 1; return storedRule; },
  hasCredits: async (id, n) => db.balance >= n,
  spendCredit: async (id, n) => { if (db.balance < n) return false; db.balance -= n; db.spent.push(n); return true; },
  refundCredit: async (id, n) => { db.balance += n; },
  getUserById: async (id) => ({ id, role: 'user', creditBalance: db.balance }),
});
stub('models/ebayAccountsModel', {
  listEbayAccounts: async () => [UK],
  getActiveEbayAccount: async () => UK,
  getEbayAccountById: async () => UK,
});
stub('models/listingsModel', {
  listListingsBySkus: async () => [], listListingsBySku: async () => [], findListingInStore: async () => null,
  upsertDraft: async (userId, fields) => { db.drafts.push(fields); return { id: 'D' + db.drafts.length, status: 'draft' }; },
});
stub('models/importsModel', { createImport: async () => ({ id: 'IMP1' }), updateImportImages: async () => {} });
stub('services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls });
stub('services/productCacheService', { getCachedProduct: async () => null, setCachedProduct: async () => {} });
stub('services/currencyService', {
  convertAmount: async (amount, from, to) => {
    if (fxDown) throw new Error('Exchange rates are unavailable right now.');
    if (from === to) return { amount, rate: 1, converted: false };
    const rate = rates[from + '>' + to];
    if (!rate) throw new Error('No exchange rate for ' + from + ' to ' + to + '.');
    return { amount: Number((amount * rate).toFixed(2)), rate, converted: true };
  },
});
const realCanopy = require('../services/canopyAmazonService');
stub('services/canopyAmazonService', { ...realCanopy, fetchProductByUrl: async (url) => ({ asin: realCanopy.extractAsinFromUrl(url), title: 'Widget', price: 8, currency: 'GBP', images: [], bulletPoints: [], specifications: [], sourceUrl: url }) });
stub('models/bulkImportJobsModel', { activeJobStats: async () => ({ jobs: 0, pendingItems: 0 }), createBulkImportJob: async (userId, job) => { db.jobs.push(job); return { id: 'J1', total: job.items.length }; } });
stub('services/veroSettingsService', { getVeroWordsOf: async () => [] });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const P = require('../services/pricingService');
const { priceByRule, markupGiven } = require('../services/importPricingService');
const browserImport = require('../routes/browserImport');
const fetchRoutes = require('../routes/fetchProduct');
const { processOneJob } = require('../jobs/bulkImportProcessor');
const { repriceFor } = require('../services/repricingService');

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (router, p, body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await handler(router, 'post', p)({ userId: 'u1', body, headers: {}, protocol: 'https', get: () => 'x' }, res); return res; };
const UK = { id: 'a'.repeat(24), label: 'Trendy UK', marketplaceId: 'EBAY_GB', isActive: true };
const url = (asin) => 'https://www.amazon.co.uk/dp/' + asin;
const reset = () => { db.balance = 50; db.spent = []; db.drafts = []; db.jobs = []; db.ruleReads = 0; storedRule = null; fxDown = false; rates = { 'USD>GBP': 0.8 }; delete settingsDoc.importWithoutEbayAccount; };
const RULE = { enabled: true, currency: 'GBP', feePercent: 13, feeFixed: 0.3, profitPercent: 30, profitFixed: 0, minProfit: 0, shipping: 0, centsEnding: null, tiers: [] };
const extProduct = { asin: 'B0EXTPROD1', title: 'Extension thing', price: 8, currency: 'GBP', images: [] };
const single = (extra = {}) => call(fetchRoutes, '/', { amazonUrl: url('B0SINGLE01'), ...extra });
const viaExtension = (extra = {}) => call(browserImport, '/', { amazonUrl: url('B0EXTPROD1'), product: extProduct, ...extra });

(async () => {
  // 8 GBP, 13% + 0.30 fees, 30% profit: (8 x 1.3 + 0.30) / 0.87 = 12.2989 -> 12.30
  const RULE_PRICE = 12.3;

  // ---------- which requests the rule applies to ----------
  assert.strictEqual(markupGiven(undefined), false); assert.strictEqual(markupGiven(null), false); assert.strictEqual(markupGiven(''), false); assert.strictEqual(markupGiven('  '), false);
  assert.strictEqual(markupGiven(0), true, '0% typed is a markup'); assert.strictEqual(markupGiven('0'), true); assert.strictEqual(markupGiven(30), true);

  // ---------- priceByRule on its own ----------
  reset();
  assert.strictEqual(await priceByRule({ userId: 'u1', price: 8, currency: 'GBP', markupPercent: 30, pricingRule: RULE }), null, 'a markup typed: the rule does not apply');
  assert.strictEqual(await priceByRule({ userId: 'u1', price: 8, currency: 'GBP' }), null, 'no rule saved');
  storedRule = { ...RULE, enabled: false };
  assert.strictEqual(await priceByRule({ userId: 'u1', price: 8, currency: 'GBP' }), null, 'a rule that is switched off');
  storedRule = RULE;
  for (const noCost of [null, undefined, 0, -1, 'abc', NaN]) assert.strictEqual(await priceByRule({ userId: 'u1', price: noCost, currency: 'GBP' }), null, 'no cost: ' + noCost);
  let r = await priceByRule({ userId: 'u1', price: 8, currency: 'GBP' });
  assert.deepStrictEqual([r.sellPrice, r.markupPercent, r.marginAmount, r.pricingRule.currency, r.breakdown.fees], [RULE_PRICE, 53.75, 4.3, 'GBP', 1.6]);
  assert.strictEqual(db.ruleReads > 0, true);
  // a rule handed in (a background list) is used and the seller's saved rule is not read
  db.ruleReads = 0;
  r = await priceByRule({ userId: 'u1', price: 8, currency: 'GBP', markupPercent: null, pricingRule: { ...RULE, profitPercent: 50 } });
  assert.strictEqual(r.sellPrice, P.computePrice(8, { ...RULE, profitPercent: 50 }).price);
  assert.strictEqual(db.ruleReads, 0);
  assert.strictEqual(await priceByRule({ userId: 'u1', price: 8, currency: 'GBP', pricingRule: null }), null, 'a list started with no rule stays without one');
  // a rule in another currency: the money amounts follow the product
  r = await priceByRule({ userId: 'u1', price: 8, currency: 'GBP', pricingRule: { ...RULE, currency: 'USD', feeFixed: 0.5, profitFixed: 1 } });
  assert.deepStrictEqual([r.pricingRule.currency, r.pricingRule.feeFixed, r.pricingRule.profitFixed], ['GBP', 0.4, 0.8], '0.50 and 1.00 dollars are 0.40 and 0.80 pounds');
  // fails safe
  fxDown = true;
  await assert.rejects(() => priceByRule({ userId: 'u1', price: 8, currency: 'GBP', pricingRule: { ...RULE, currency: 'USD' } }), (e) => e.statusCode === 503 && /exchange rate/.test(e.message));
  fxDown = false;
  await assert.rejects(() => priceByRule({ userId: 'u1', price: 8, currency: 'EUR', pricingRule: { ...RULE, currency: 'USD' } }), (e) => e.statusCode === 503, 'no rate for that pair');
  await assert.rejects(() => priceByRule({ userId: 'u1', price: 8, currency: 'GBP', pricingRule: { ...RULE, feePercent: 999 } }), (e) => e.statusCode === 409 && /not valid/.test(e.message), 'a broken rule is never used, and never turned into "no rule"');

  // ---------- the single import ----------
  reset();
  let res = await single();
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].markupPercent, db.drafts[0].pricingRule, res.body.suggestedPrice, res.body.pricing], [8, 0, null, null, null], 'no rule: as before (the price is the cost)');
  reset(); storedRule = RULE;
  res = await single();
  assert.strictEqual(res.body.success, true);
  let d = db.drafts[0];
  assert.deepStrictEqual([d.sellPrice, d.markupPercent, d.marginAmount, d.amazonPrice, d.currency], [RULE_PRICE, 53.75, 4.3, 8, 'GBP']);
  assert.strictEqual(d.pricingRule.feePercent, 13); assert.strictEqual(d.pricingRule.currency, 'GBP');
  assert.strictEqual(res.body.suggestedPrice, RULE_PRICE); assert.strictEqual(res.body.pricing.price, RULE_PRICE);
  assert.deepStrictEqual(db.spent, [1], 'one credit, as always');
  // an empty markup box is "no markup typed"
  reset(); storedRule = RULE;
  await single({ markupPercent: '' });
  assert.strictEqual(db.drafts[0].sellPrice, RULE_PRICE);
  // a markup typed always wins, and the draft keeps no rule
  reset(); storedRule = RULE;
  await single({ markupPercent: 30 });
  d = db.drafts[0];
  assert.deepStrictEqual([d.sellPrice, d.markupPercent, d.marginAmount, d.pricingRule], [10.4, 30, 2.4, null]);
  reset(); storedRule = RULE;
  await single({ markupPercent: 0 });
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].pricingRule], [8, null], '0% typed is honoured');
  // a rule that is off changes nothing
  reset(); storedRule = { ...RULE, enabled: false };
  await single();
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].pricingRule], [8, null]);
  // a rule that cannot be used: nothing saved, nothing charged
  reset(); storedRule = { ...RULE, feePercent: 999 };
  res = await single();
  assert.strictEqual(res.statusCode, 409); assert.match(res.body.error, /pricing rule is not valid/);
  assert.deepStrictEqual([db.drafts.length, db.balance], [0, 50], 'no draft, and the credit is back');
  reset(); storedRule = { ...RULE, currency: 'USD' }; fxDown = true;
  res = await single();
  assert.strictEqual(res.statusCode, 503);
  assert.deepStrictEqual([db.drafts.length, db.balance], [0, 50]);
  reset(); storedRule = { ...RULE, currency: 'USD', feeFixed: 0.5, profitFixed: 1 };
  res = await single();
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db.drafts[0].pricingRule.feeFixed, 0.4, 'a rule in dollars, a product in pounds');

  // ---------- the extension's import ----------
  reset(); storedRule = RULE;
  res = await viaExtension();
  assert.strictEqual(res.body.success, true);
  d = db.drafts[0];
  assert.deepStrictEqual([d.sellPrice, d.markupPercent, d.marginAmount, d.pricingRule.currency, res.body.suggestedPrice, res.body.pricing.price], [RULE_PRICE, 53.75, 4.3, 'GBP', RULE_PRICE, RULE_PRICE]);
  reset(); storedRule = RULE;
  await viaExtension({ markupPercent: '' });
  assert.strictEqual(db.drafts[0].sellPrice, RULE_PRICE, 'the extension leaves the box empty: the rule');
  reset(); storedRule = RULE;
  await viaExtension({ markupPercent: 20 });
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].pricingRule], [9.6, null], 'a markup typed in the extension wins');
  reset();
  await viaExtension();
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].markupPercent, db.drafts[0].pricingRule], [8, 0, null], 'no rule: as before');
  reset(); storedRule = { ...RULE, profitPercent: 5000 };
  res = await viaExtension();
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual([db.drafts.length, db.balance], [0, 50], 'a broken rule: nothing saved, nothing charged');

  // ---------- the background list ----------
  reset(); storedRule = RULE;
  res = await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')] });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual([db.jobs[0].markupPercent, db.jobs[0].pricingRule.feePercent, db.jobs[0].pricingRule.currency], [0, 13, 'GBP'], 'the list keeps the rule of the moment it started');
  reset(); storedRule = RULE;
  await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')], markupPercent: 12 });
  assert.deepStrictEqual([db.jobs[0].markupPercent, db.jobs[0].pricingRule], [12, null]);
  reset(); storedRule = RULE;
  await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')], markupPercent: 0 });
  assert.deepStrictEqual([db.jobs[0].markupPercent, db.jobs[0].pricingRule], [0, null], '0% typed is a markup');
  reset();
  await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')] });
  assert.deepStrictEqual([db.jobs[0].markupPercent, db.jobs[0].pricingRule], [0, null], 'no rule: as before');
  reset(); storedRule = { ...RULE, enabled: false };
  await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')] });
  assert.strictEqual(db.jobs[0].pricingRule, null);
  reset(); storedRule = { ...RULE, feePercent: 999 };
  res = await call(fetchRoutes, '/bulk-job', { amazonUrls: [url('B0LISTJOB1')] });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.jobs.length, 0, 'a broken rule starts no list');

  // the job's items are priced with the kept rule, not with whatever the seller saved since
  reset(); storedRule = { ...RULE, profitPercent: 300 }; // changed in Settings after the list started
  const mkJob = (extra) => ({ userId: 'u1', source: 'website', status: 'polling', markupPercent: 0, createdAt: new Date(), items: [{ status: 'fetched', amazonUrl: url('B0PROC0001'), asin: 'B0PROC0001', country: 'GB', product: { asin: 'B0PROC0001', title: 't', price: 8, currency: 'GBP', images: [] } }], save: async () => {}, ...extra });
  let job = mkJob({ pricingRule: RULE });
  await processOneJob(job, fetchRoutes.saveProductAsDraft);
  assert.strictEqual(job.items[0].status, 'done', job.items[0].error);
  assert.strictEqual(db.drafts[0].sellPrice, RULE_PRICE, 'priced by the rule the list started with');
  assert.strictEqual(db.ruleReads, 0, 'the seller\'s current rule is not read for a list that has its own');
  reset();
  job = mkJob({ pricingRule: null, markupPercent: 10 });
  await processOneJob(job, fetchRoutes.saveProductAsDraft);
  assert.deepStrictEqual([db.drafts[0].sellPrice, db.drafts[0].pricingRule], [8.8, null], 'a list with a markup: as before');
  reset(); storedRule = RULE;
  job = mkJob({ pricingRule: { ...RULE, currency: 'USD' } }); fxDown = true;
  await processOneJob(job, fetchRoutes.saveProductAsDraft);
  assert.strictEqual(job.items[0].status, 'error');
  assert.match(job.items[0].error, /exchange rate/);
  assert.deepStrictEqual([db.drafts.length], [0]);

  // ---------- a draft keeps its rule; a hand-typed price ends it (updateListing) ----------
  {
    let existing; let saved;
    stub('models/schemas/Listing', {
      findOne: () => { const q = { select: () => q, lean: async () => existing }; return q; },
      findOneAndUpdate: async (filter, update) => { saved = update; return { toObject: () => ({ _id: 'L1', ...update }), ...update, _id: 'L1' }; },
    });
    delete require.cache[require.resolve('../models/listingsModel')];
    const { updateListing } = require('../models/listingsModel');
    const snapshot = { ...RULE };
    existing = { sellPrice: 12.3, amazonPrice: 8, pricingRule: snapshot };
    await updateListing('u1', 'L1', { title: 'New title', sellPrice: 12.3 });
    assert.ok(!('pricingRule' in saved), 'saving the same price again (an editor save that changed the title) keeps the rule');
    await updateListing('u1', 'L1', { title: 'x' });
    assert.ok(!('pricingRule' in saved), 'no price in the save: the rule stays');
    await updateListing('u1', 'L1', { sellPrice: 14.99 });
    assert.strictEqual(saved.pricingRule, null, 'a price typed by hand ends the rule for this listing');
    await updateListing('u1', 'L1', { sellPrice: 12.31 });
    assert.strictEqual(saved.pricingRule, null, 'even one cent more is a different price');
    await updateListing('u1', 'L1', { sellPrice: 15, pricingRule: snapshot });
    assert.deepStrictEqual(saved.pricingRule, snapshot, 'the re-pricing job passes the rule so it stays');
    await updateListing('u1', 'L1', { pricingRule: null });
    assert.strictEqual(saved.pricingRule, null, 'and it can be removed on purpose');
    existing = { sellPrice: 12.3, amazonPrice: 8, pricingRule: null };
    await updateListing('u1', 'L1', { sellPrice: 20 });
    assert.ok(!('pricingRule' in saved), 'a listing with no rule is left as it is');
  }

  // ---------- re-pricing when the Amazon price changes ----------
  const ruled = { pricing_rule: RULE, amazon_price: 8, sell_price: RULE_PRICE };
  let rp = repriceFor(ruled, 10, 4.3);
  assert.deepStrictEqual([rp.sellPrice, rp.marginAmount, rp.rule.feePercent], [P.computePrice(10, RULE).price, Number((P.computePrice(10, RULE).price - 10).toFixed(2)), 13], 'the rule prices the new cost: fees and profit % stay');
  assert.strictEqual(rp.sellPrice, 15.29);
  rp = repriceFor({ amazon_price: 8, sell_price: 10.4, pricing_rule: null }, 10, 2.4);
  assert.deepStrictEqual(rp, { sellPrice: 12.4, marginAmount: 2.4, rule: null }, 'no rule: the cash margin is kept, exactly as before');
  rp = repriceFor({ amazon_price: 8 }, 10, 2.4);
  assert.strictEqual(rp.sellPrice, 12.4);
  assert.strictEqual(repriceFor(ruled, 0, 4.3), null, 'a cost of 0 gives no price');
  assert.strictEqual(repriceFor({ pricing_rule: { ...RULE, feePercent: 100 } }, 10, 4.3), null, 'a rule that cannot price gives none (the baseline stays, the next check retries)');

  console.log('pricing in imports: all good');
})().catch((err) => { console.error(err); process.exit(1); });
