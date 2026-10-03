// A product eBay does not allow is NEVER listed: the real publish worker (processOneQueuedListing - the one place the instant publish, the background
// runner, the scheduler and the extension all end up) checks the text that would be sent against eBay's list of prohibited items BEFORE the eBay
// account is read, before the credit is charged and before any eBay call. The person gets the reason in Needs attention; nothing is charged.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const seen = { account: 0, spend: 0, refund: 0, publish: 0, errors: [], notes: [], location: 0, suggest: 0 };
let settingsDoc = null; let settingsFail = false;
stub('models/schemas/Settings', { findOne: () => ({ lean: async () => { if (settingsFail) throw new Error('database is down'); return settingsDoc; } }) });
stub('services/ebayTaxonomyService', { suggestCategories: async () => { seen.suggest += 1; return { topSuggestion: null }; }, getItemAspectsForCategory: async () => ({ aspects: [] }) });
stub('models/ebayAccountsModel', {
  getEbayAccountById: async () => { seen.account += 1; return null; }, // the step right AFTER the policy check: reaching it means "not blocked"
  getEbayAccountRefreshToken: async () => 'rt',
});
let product = {};
stub('models/importsModel', { getImportById: async () => ({ product }) });
stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => { seen.spend += 1; return true; }, refundCredit: async () => { seen.refund += 1; } });
stub('models/systemNotificationsModel', { createSystemNotification: async (u, n) => { seen.notes.push(n); return {}; } });
stub('services/ebayListingService', { publishListing: async () => { seen.publish += 1; return {}; }, createOrGetCustomLocation: async () => { seen.location += 1; return {}; }, fulfillmentPolicyUsesCalculatedShipping: async () => false });
stub('services/publishPreflightService', { prepareAspects: async () => ({}), assertUsableCategory: async () => {} });
let row;
stub('models/listingsModel', {
  listPublishingListings: async () => [], getListingById: async () => row, markPublished: async () => ({}), markPublishCreditCharged: async () => {},
  acquirePublishLease: async () => row, updateListing: async () => {},
  markError: async (u, id, message) => { seen.errors.push(message); return { id, status: 'error', error_message: message }; },
});

const P = require('../services/prohibitedItemsService');
P.deps.isConnected = () => true;
const { processOneQueuedListing } = require('../services/publishQueueService');
const inAMinute = async (fn) => { const realNow = Date.now; Date.now = () => realNow() + 120 * 1000; try { return await fn(); } finally { Date.now = realNow; } }; // the rules are re-read at most once a minute

const reset = () => { seen.account = 0; seen.spend = 0; seen.refund = 0; seen.publish = 0; seen.errors.length = 0; seen.notes.length = 0; seen.location = 0; seen.suggest = 0; settingsDoc = null; settingsFail = false; P.setSettings({}); };
const listing = (over = {}) => ({ id: 'L9', userId: 'u1', status: 'publishing', title: product.title, ebay_account_id: 'A1', import_id: 'I1', sell_price: 20, category_id: '177', publish_credit_charged: false, ...over });
const run = async (over) => { row = listing(over); return processOneQueuedListing(row); };
const PASSED = 'The selected eBay account could not be found. Please reconnect it.'; // what the worker says one step later: the policy check let it through

(async () => {
  // ---------- a product eBay does not allow: stopped with the reason, before the account, the credit and eBay ----------
  reset(); product = { title: 'Disposable Vape Pen 5000 Puffs Blue Razz', description: 'Fine', bulletPoints: [], specifications: [], categories: ['Electronics'] };
  let out = await run();
  assert.strictEqual(out.status, 'error');
  assert.strictEqual(seen.errors.length, 1);
  assert.match(seen.errors[0], /^Not allowed on eBay \(Tobacco, e-cigarettes and vaping\): "vape pen" is in the title\. eBay does not allow tobacco/);
  assert.match(seen.errors[0], /ELMS will not list this product\.$/);
  assert.deepStrictEqual([seen.account, seen.spend, seen.refund, seen.publish, seen.location], [0, 0, 0, 0, 0], 'no eBay account read, no credit charged or refunded, nothing sent to eBay');
  assert.strictEqual(seen.notes.length, 1); assert.strictEqual(seen.notes[0].type, 'publish_failed'); assert.match(seen.notes[0].message, /Not allowed on eBay/, 'the person is told in the bell too');
  assert.strictEqual(seen.notes[0].metadata.code, 'EBAY_POLICY_BLOCKED', 'with a code a screen can recognise');

  // a draft with no category yet: eBay is NOT asked to suggest one (that can cost a credit) for a product that will not be listed
  reset(); out = await run({ category_id: null });
  assert.match(seen.errors[0], /^Not allowed on eBay/); assert.strictEqual(seen.suggest, 0, 'no category suggestion for a blocked product');
  // ... while an ordinary one still gets its suggestion (here eBay has none, so the worker says what to do)
  reset(); product = { title: 'Cool Mist Humidifier 4L', description: 'Quiet' }; out = await run({ category_id: null });
  assert.strictEqual(seen.suggest, 1); assert.match(seen.errors[0], /^No eBay category is set/);
  reset(); product = { title: 'Disposable Vape Pen 5000 Puffs Blue Razz', description: 'Fine', bulletPoints: [], specifications: [], categories: ['Electronics'] };

  // the same product again (Retry): stopped again, the same way
  reset(); out = await run();
  assert.match(seen.errors[0], /^Not allowed on eBay/); assert.strictEqual(seen.account, 0);

  // wherever the word is: description, bullet points, specifications, item specifics, brand
  for (const [label, p] of [
    ['description', { title: 'Plain Charger', description: '<p>Works as a <b>Taser</b></p>' }],
    ['bullet points', { title: 'Plain Charger', bulletPoints: ['Hidden Spy Camera inside'] }],
    ['specifications', { title: 'Plain Charger', specifications: [{ name: 'Type', value: 'Water Bong' }] }],
    ['item specifics', { title: 'Plain Charger', ebayAspects: { Type: ['E-Liquid'] } }],
    ['brand', { title: 'Plain Charger', brand: 'Elf Bar' }],
  ]) {
    reset(); product = p; out = await run();
    assert.strictEqual(out.status, 'error', label); assert.match(seen.errors[0], /^Not allowed on eBay/, label); assert.strictEqual(seen.account, 0, label);
  }

  // ---------- an ordinary product goes on past the check (to the account step, which these stand-ins refuse) ----------
  reset(); product = { title: 'Cool Mist Humidifier Vaporizer 4L', description: 'Quiet', bulletPoints: ['Easy to clean'], specifications: [{ name: 'Color', value: 'White' }], categories: ['Home & Kitchen'] };
  out = await run();
  assert.deepStrictEqual(seen.errors, [PASSED]); assert.strictEqual(seen.account, 1);

  // ---------- the person edited the draft: what would be SENT is checked, not the old import ----------
  reset(); product = { title: 'Disposable Vape Pen', description: 'Vape pen description', bulletPoints: ['Vape pen'], specifications: [] };
  out = await run({ title: 'Portable Phone Charger', description: 'Fast charging', bullet_points: ['Charges fast'], specifications: [{ name: 'Color', value: 'Black' }] });
  assert.deepStrictEqual(seen.errors, [PASSED], 'renamed and rewritten: allowed');
  reset(); out = await run({ title: 'Portable Phone Charger' }); // title fixed, description still names it
  assert.match(seen.errors[0], /"vape pen" is in the description/);

  // ---------- books, films, music and games may be ABOUT a subject: not stopped ----------
  reset(); product = { title: 'The Cocaine Chronicles: A Novel', description: 'A story of heroin and marijuana.', categories: ['Books', 'Literature & Fiction'] };
  out = await run();
  assert.deepStrictEqual(seen.errors, [PASSED], 'a book about drugs is a book');
  reset(); product = { title: 'Bootleg DVD Live Concert', categories: ['Movies & TV'] };
  out = await run();
  assert.match(seen.errors[0], /^Not allowed on eBay \(Pirated media and software\)/, 'but a bootleg copy is not allowed in any category');

  // ---------- the admin's rules are loaded first and apply ----------
  reset(); product = { title: 'Disposable Vape Pen' };
  settingsDoc = { ebayPolicy: { disabledAreas: ['tobacco'], extraTerms: [], allowPhrases: [] } };
  out = await inAMinute(() => run()); // nobody refreshed the rules: the gate loads them itself
  assert.deepStrictEqual(seen.errors, [PASSED], 'the admin switched that area off');
  reset(); product = { title: 'Acme Zorp Widget' };
  settingsDoc = { ebayPolicy: { disabledAreas: [], extraTerms: [{ area: 'custom', term: 'zorp widget' }], allowPhrases: [] } };
  await P.refreshSettings({ force: true });
  out = await run();
  assert.match(seen.errors[0], /^Not allowed on eBay \(Added by the ELMS admin\): "zorp widget" is in the title\./, 'a word the admin added');
  reset(); product = { title: 'Practice Taser Prop Toy' };
  settingsDoc = { ebayPolicy: { disabledAreas: [], extraTerms: [], allowPhrases: ['practice taser prop toy'] } };
  await P.refreshSettings({ force: true });
  out = await run();
  assert.deepStrictEqual(seen.errors, [PASSED], 'a phrase the admin allowed');

  // ---------- the settings cannot be read (the engine test covers the reload itself): the built-in list is still what stops it - the check never fails open ----------
  reset(); product = { title: 'Brass Knuckles Gold' };
  settingsFail = true;
  out = await run();
  assert.match(seen.errors[0], /^Not allowed on eBay \(Prohibited weapons/);
  assert.strictEqual(seen.account, 0);

  // ---------- an already-charged listing that is stopped has its credit given back by the same failure path ----------
  reset(); product = { title: 'Disposable Vape Pen' };
  out = await run({ publish_credit_charged: true });
  assert.strictEqual(seen.refund, 1, 'a credit charged by an earlier try is refunded');

  console.log('publish policy gate tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
