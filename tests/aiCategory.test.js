// A category list per eBay marketplace (the CSV the admin uploads) and the AI backup that uses it when eBay's daily limit for category lookups is
// used up: the CSV is read the way eBay writes it, the categories that look like a title are found, the AI chooses ONE of them (an ID that is
// not in the list is never taken), the seller pays the admin-set AI_CATEGORY credits (given back when nothing is found), the same product
// words are not asked twice, and every case where the backup cannot help leaves eBay's own limit message as it was.
// The real code runs; MongoDB, the AI and the credits are stand-ins.
const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

// ---- MongoDB stand-in: the category lists ----
const stored = new Map();
let stamp = 1;
stub('models/schemas/EbayCategoryList', {
  findOneAndUpdate: async (q, u) => { stored.set(q.marketplaceId, { marketplaceId: q.marketplaceId, ...u.$set, updatedAt: new Date(1700000000000 + (stamp += 1000)) }); },
  find: () => ({ select: () => ({ lean: async () => [...stored.values()].map(({ data, ...rest }) => rest) }) }),
  findOne: (q) => { const row = stored.get(q.marketplaceId) || null; return { select: () => ({ lean: async () => (row ? { updatedAt: row.updatedAt } : null) }), then: (res, rej) => Promise.resolve(row).then(res, rej) }; },
  deleteOne: async (q) => ({ deletedCount: stored.delete(q.marketplaceId) ? 1 : 0 }),
});

// ---- the AI, the credits, the settings ----
let aiOn = true;
let switchOn = true;
const asked = [];
let answer = async () => ({ text: '{"id":"20345"}' });
stub('services/aiService', { aiConfigured: () => aiOn, askClaude: async (o) => { asked.push(o); const r = await answer(o, asked.length); return { text: r.text, model: 'claude-test', inputTokens: 900, outputTokens: 12 }; } });
stub('models/settingsModel', { getAiSettings: async () => ({ aiCategoryEnabled: switchOn }) });
let balance = 10;
const spends = [];
stub('models/usersModel', {
  spendCredit: async (u, cost) => { spends.push(cost); if (balance < cost) return false; balance -= cost; return true; },
  refundCredit: async (u, cost) => { balance += cost; },
});
const usageRows = [];
stub('models/schemas/AiUsage', { create: (row) => { usageRows.push(row); return Promise.resolve(); } });
let ebay = async () => { throw Object.assign(new Error("eBay's daily limit for category lookups is used up."), { statusCode: 429, limitReached: true }); };
const ebayCalls = [];
stub('services/ebayTaxonomyService', { suggestCategories: async (t, title, mp) => { ebayCalls.push({ title, mp }); return ebay(title, mp); }, getItemAspectsForCategory: async () => ({ aspects: [] }) });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => ({ marketplaceId: 'EBAY_GB' }), getEbayAccountRefreshToken: async () => 'rt' });

const { ACTION_COSTS, ACTION_COST_METADATA } = require('../config/actionCosts');
const L = require('../services/categoryListService');
const { suggestCategoriesWithBackup, parseAnswer, _picks } = require('../services/aiCategoryService');
const { ensureDraftCategory } = require('../services/draftCategoryService');

const filler = Array.from({ length: 30 }, (_, i) => (5000 + i) + ',"Filler > Group ' + i + ' > Thing ' + i + '"').join('\r\n');
const csvOf = (extra) => '﻿CategoryID,Category Path\r\n' + extra.join('\r\n') + '\r\n' + filler + '\r\n';
const REAL = [
  '20345,"Home & Garden > Kitchen, Dining & Bar > Small Kitchen Appliances > Tea Kettles"',
  '15709,"Clothing, Shoes & Accessories > Men\'s Shoes > Athletic Shoes"',
  '18826,"Entertainment Memorabilia > Movie Memorabilia > Photographs > 1940-49 > Black & White"',
  '23160,"Computers/Tablets & Networking > Keyboards, Mice & Pointers > Mice, Trackballs & Touchpads"',
  '20460,"Home & Garden > Bedding > Sheets & Pillowcases"',
  '158928,"Sporting Goods > Fitness, Running & Yoga > Yoga & Pilates > Mats & Non-Slip Towels"',
  '44995,"Computers/Tablets & Networking > Home Networking & Connectivity > Wireless Routers"',
];

(async () => {
  // ---------- the CSV, the way eBay writes it ----------
  let p = L.parseCategoryCsv(csvOf([
    '78172,"Dolls & Bears > Dolls > By Brand, Company, Character > Tonner > 18" Kitty Collier Collection"', // commas inside, a lone quote inside (eBay's own file has these)
    '5,"A ""quoted"" name > B"',
    'abc,"Not > A number"', // skipped
    '6,""', // skipped: no path
    '7,"First > Version"',
    '7,"Second > Version"', // the same ID again: the last one wins
    ...REAL,
  ]));
  const byId = new Map(p.rows.map((r) => [r.id, r.path]));
  assert.strictEqual(byId.get('78172'), 'Dolls & Bears > Dolls > By Brand, Company, Character > Tonner > 18" Kitty Collier Collection', 'commas and a lone quote stay in the path');
  assert.strictEqual(byId.get('5'), 'A "quoted" name > B');
  assert.strictEqual(byId.get('7'), 'Second > Version'); assert.strictEqual(p.duplicates, 1); assert.strictEqual(p.skipped, 2);
  assert.strictEqual(byId.get('20345'), 'Home & Garden > Kitchen, Dining & Bar > Small Kitchen Appliances > Tea Kettles', 'the BOM and Windows line ends are handled');
  assert.strictEqual(p.rows.length, 30 + 3 + REAL.length, 'every good row, once (the filler, three special rows, the real ones)');
  // other separators and no header
  p = L.parseCategoryCsv('categoryid;categorypath\n' + Array.from({ length: 25 }, (_, i) => (100 + i) + ';A > B ' + i).join('\n'));
  assert.strictEqual(p.rows.length, 25);
  p = L.parseCategoryCsv(Array.from({ length: 25 }, (_, i) => (100 + i) + '\tA > B ' + i).join('\n'));
  assert.deepStrictEqual([p.rows.length, p.rows[0].id, p.rows[0].path], [25, '100', 'A > B 0'], 'a tab-separated file with no header');
  assert.throws(() => L.parseCategoryCsv('  \n'), /empty/);
  assert.throws(() => L.parseCategoryCsv('Name,Price\nA,1\n'), /does not look like eBay's category list.*CategoryID/);
  assert.throws(() => L.parseCategoryCsv('CategoryID,Category Path\n1,"A > B"\n2,"A > C"\n'), /Only 2 category rows/);

  // ---------- finding the categories that look like a title ----------
  const index = L.buildIndex(L.parseCategoryCsv(csvOf(REAL)).rows);
  const top = (text) => L.shortlist(index, text, 40).map((c) => c.id);
  assert.strictEqual(top('Stainless Steel Electric Kettle 1.7L Cordless Water Boiler')[0], '20345');
  assert.strictEqual(top('Nike Mens Air Max Running Shoes Black White Size 10')[0], '15709', 'the colours do not lead to "Black & White" photographs');
  assert.ok(top('Wireless Computer Mouse Ergonomic').includes('23160'), 'mouse finds "Mice" (an irregular plural)');
  assert.strictEqual(top('Cotton Bed Sheets Deep Pocket')[0], '20460');
  assert.strictEqual(top('Yoga Mats Non Slip')[0], '158928', 'plural and singular are the same word');
  assert.deepStrictEqual(top('zzzz qqqq'), [], 'nothing matches: nothing is listed');
  assert.strictEqual(L.shortlist(index, 'kettle', 3).length, 1, 'only categories that share a word are listed');

  // ---------- one list per marketplace ----------
  assert.strictEqual(await L.getIndex('EBAY_GB'), null, 'nothing uploaded yet');
  await assert.rejects(() => L.saveCategoryList('EBAY_XX', csvOf(REAL)), /Unsupported eBay marketplace/);
  await assert.rejects(() => L.saveCategoryList('ebay_gb', 'Name,Price\nA,1\n'), /does not look like eBay's category list/);
  assert.strictEqual(stored.size, 0, 'a bad file saves nothing');
  const saved = await L.saveCategoryList('ebay_gb', csvOf(REAL), { filename: 'CategoryIDs-UK.csv' });
  assert.deepStrictEqual([saved.marketplaceId, saved.count], ['EBAY_GB', 30 + REAL.length]);
  assert.ok((await L.getIndex('EBAY_GB')).byId.has('20345'));
  assert.deepStrictEqual(await L.categoryById('EBAY_GB', '23160'), { id: '23160', path: 'Computers/Tablets & Networking > Keyboards, Mice & Pointers > Mice, Trackballs & Touchpads', name: 'Mice, Trackballs & Touchpads' });
  assert.strictEqual(await L.categoryById('EBAY_GB', '999999'), null);
  assert.strictEqual(await L.getIndex('EBAY_DE'), null, 'another country has its own list');
  await L.saveCategoryList('EBAY_GB', csvOf(['555,"Only > New"']));
  assert.ok((await L.getIndex('EBAY_GB')).byId.has('555') && !(await L.getIndex('EBAY_GB')).byId.has('20345'), 'a new upload replaces the list at once');
  await L.saveCategoryList('EBAY_GB', csvOf(REAL), { filename: 'CategoryIDs-UK.csv' });
  const all = await L.listCategoryLists();
  assert.deepStrictEqual(all.slice(0, 3).map((r) => r.marketplaceId), ['EBAY_US', 'EBAY_GB', 'EBAY_DE'], 'the main sites come first');
  assert.strictEqual(all.length, 19);
  const gb = all.find((r) => r.marketplaceId === 'EBAY_GB');
  assert.deepStrictEqual([gb.uploaded, gb.count, gb.filename, gb.domain, gb.country], [true, 30 + REAL.length, 'CategoryIDs-UK.csv', 'ebay.co.uk', 'GB']);
  assert.strictEqual(all.find((r) => r.marketplaceId === 'EBAY_US').uploaded, false);

  // ---------- what the AI writes ----------
  assert.deepStrictEqual(parseAnswer('{"id":"123"}'), { id: '123', search: '' });
  assert.deepStrictEqual(parseAnswer('Sure! {"id": 456}'), { id: '456', search: '' });
  assert.deepStrictEqual(parseAnswer('{"id":null,"search":"computer mice"}'), { id: '', search: 'computer mice' });
  assert.deepStrictEqual(parseAnswer('The category is 789.'), { id: '789', search: '' });
  assert.deepStrictEqual(parseAnswer('no idea'), { id: '', search: '' });

  // ---------- the backup ----------
  const limitMessage = "eBay's daily limit for category lookups is used up.";
  const reset = () => { asked.length = 0; spends.length = 0; usageRows.length = 0; ebayCalls.length = 0; _picks.clear(); balance = 10; aiOn = true; switchOn = true; ACTION_COSTS.AI_CATEGORY = 2; answer = async () => ({ text: '{"id":"20345"}' }); ebay = async () => { throw Object.assign(new Error(limitMessage), { statusCode: 429, limitReached: true }); }; };
  assert.strictEqual(ACTION_COST_METADATA.filter((m) => m.key === 'AI_CATEGORY').length, 1, 'the admin sees it in the credit costs list');
  const title = 'Stainless Steel Electric Kettle 1.7L Cordless Water Boiler with Auto Shut-Off';

  // eBay answers: nothing else happens
  reset(); ebay = async () => ({ topSuggestion: { categoryId: '1', categoryName: 'X' }, suggestions: [] });
  let r = await suggestCategoriesWithBackup('u1', title, 'EBAY_GB');
  assert.strictEqual(r.topSuggestion.categoryId, '1'); assert.strictEqual(r.source, undefined); assert.strictEqual(asked.length + spends.length, 0, 'eBay first: no AI, no credits');

  // eBay's limit is used up: the AI chooses from the list, the seller pays the admin-set credits
  reset();
  r = await suggestCategoriesWithBackup('u1', title, 'EBAY_GB');
  assert.deepStrictEqual(r.topSuggestion, { categoryId: '20345', categoryName: 'Tea Kettles', fullPath: 'Home & Garden > Kitchen, Dining & Bar > Small Kitchen Appliances > Tea Kettles' });
  assert.deepStrictEqual([r.source, r.creditsUsed, spends, balance], ['ai', 2, [2], 8], 'charged what the admin set');
  assert.strictEqual(asked.length, 1);
  assert.ok(asked[0].prompt.includes('Product title: ' + title) && asked[0].prompt.includes('20345 | Home & Garden > Kitchen, Dining & Bar > Small Kitchen Appliances > Tea Kettles') && asked[0].prompt.includes('ebay.co.uk'), 'the title and real categories with their IDs');
  assert.ok(/JSON only/.test(asked[0].system) && /Never make up an ID/.test(asked[0].system));
  assert.deepStrictEqual(usageRows, [{ userId: 'u1', kind: 'category', ok: true, credits: 2, model: 'claude-test', inputTokens: 900, outputTokens: 12 }]);
  // the same product words again: not asked again, nothing charged
  r = await suggestCategoriesWithBackup('u2', title.toUpperCase(), 'EBAY_GB');
  assert.deepStrictEqual([r.topSuggestion.categoryId, r.creditsUsed, asked.length, spends.length], ['20345', 0, 1, 1], 'a repeat is free');
  // another marketplace is another question
  await L.saveCategoryList('EBAY_DE', csvOf(REAL));
  await suggestCategoriesWithBackup('u2', title, 'EBAY_DE'); assert.strictEqual(asked.length, 2);

  // an ID that is not in the list is never taken; the credits come back
  reset(); answer = async () => ({ text: '{"id":"999999"}' });
  await assert.rejects(() => suggestCategoriesWithBackup('u1', title, 'EBAY_GB'), (e) => e.limitReached === true && e.aiBackup === 'failed' && e.message.startsWith(limitMessage) && /could not help: no category in the list fits/.test(e.message));
  assert.deepStrictEqual([balance, usageRows.length, usageRows[0].ok, usageRows[0].credits], [10, 1, false, 0], 'nothing found: nothing charged');
  // "none fits" with words to search: a second look with those words
  reset();
  answer = async (o, n) => (n === 1 ? { text: '{"id":null,"search":"computer mice trackballs"}' } : { text: '{"id":"23160"}' });
  r = await suggestCategoriesWithBackup('u1', 'Logitech MX Master 3S Performance Ergonomic', 'EBAY_GB');
  assert.strictEqual(r.topSuggestion.categoryId, '23160'); assert.strictEqual(asked.length, 2);
  assert.ok(!asked[0].prompt.includes('23160 |') && asked[1].prompt.includes('23160 | Computers/Tablets & Networking > Keyboards, Mice & Pointers'), 'the second list came from the AI\'s own words');
  assert.deepStrictEqual([spends, usageRows[0].inputTokens], [[2], 1800], 'one charge for both looks; both looks are counted');
  // a plain number is accepted when it is in the list
  reset(); answer = async () => ({ text: '20460' });
  assert.strictEqual((await suggestCategoriesWithBackup('u1', 'Cotton Bed Sheets Deep Pocket', 'EBAY_GB')).topSuggestion.categoryId, '20460');
  // two looks and still nothing
  reset(); answer = async () => ({ text: '{"id":null,"search":"something else"}' });
  await assert.rejects(() => suggestCategoriesWithBackup('u1', 'Qwerty Zxcvb', 'EBAY_GB'), /could not help/); assert.strictEqual(balance, 10); assert.ok(asked.length <= 2);
  // the AI itself fails: credits back, a reason
  reset(); answer = async () => { throw Object.assign(new Error('The AI service could not be reached.'), { statusCode: 502 }); };
  await assert.rejects(() => suggestCategoriesWithBackup('u1', title, 'EBAY_GB'), /could not help: The AI service could not be reached/); assert.strictEqual(balance, 10);
  // too few credits: the AI is not asked
  reset(); balance = 1;
  await assert.rejects(() => suggestCategoriesWithBackup('u1', title, 'EBAY_GB'), (e) => e.outOfCredits === true && e.limitReached === true && /needs 2 credits and there are not enough/.test(e.message));
  assert.strictEqual(asked.length, 0);
  // free when the admin sets 0
  reset(); ACTION_COSTS.AI_CATEGORY = 0;
  r = await suggestCategoriesWithBackup('u1', title, 'EBAY_GB'); assert.deepStrictEqual([r.creditsUsed, balance], [0, 10]);

  // cases where the backup cannot help: eBay's own message, unchanged
  for (const [name, setup, mp] of [['the admin switch is off', () => { switchOn = false; }, 'EBAY_GB'], ['no AI key', () => { aiOn = false; }, 'EBAY_GB'], ['no list for this marketplace', () => {}, 'EBAY_AU']]) {
    reset(); setup();
    await assert.rejects(() => suggestCategoriesWithBackup('u1', title, mp), (e) => e.message === limitMessage && e.limitReached === true && !e.aiBackup, name);
    assert.strictEqual(asked.length + spends.length, 0, name);
  }
  // another kind of eBay error goes straight through
  reset(); ebay = async () => { throw new Error('eBay is busy'); };
  await assert.rejects(() => suggestCategoriesWithBackup('u1', title, 'EBAY_GB'), /^Error: eBay is busy$/);

  // ---------- publishing a draft with no category ----------
  const saves = [];
  const save = async (u, id, fields) => { saves.push({ u, id, fields }); };
  const draft = { id: 'L1', title, category_id: null, marketplace_id: 'EBAY_GB', ebay_account_id: 'A1' };
  reset();
  let out = await ensureDraftCategory('u1', draft, { save });
  assert.deepStrictEqual([out.categoryId, out.picked, out.source, out.creditsUsed], ['20345', true, 'ai', 2]);
  assert.deepStrictEqual(saves, [{ u: 'u1', id: 'L1', fields: { categoryId: '20345' } }], 'saved on the draft, so a retry never asks (or charges) again');
  // eBay's limit and no backup: ONE try, at once (it used to wait and ask three times), with the reason
  reset(); switchOn = false; saves.length = 0;
  const started = Date.now();
  await assert.rejects(() => ensureDraftCategory('u1', draft, { save }), /could not suggest one right now \(eBay's daily limit for category lookups is used up\.\).*choose a category/);
  assert.ok(Date.now() - started < 500 && ebayCalls.length === 1, 'not asked three times with waits in between');
  assert.strictEqual(saves.length, 0);
  // eBay answers normally: source is eBay, nothing charged
  reset(); ebay = async () => ({ topSuggestion: { categoryId: '9355', categoryName: 'Kettles' } });
  out = await ensureDraftCategory('u1', draft, { save });
  assert.deepStrictEqual([out.categoryId, out.source, out.creditsUsed, spends.length], ['9355', 'ebay', 0, 0]);

  console.log('ai category tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
