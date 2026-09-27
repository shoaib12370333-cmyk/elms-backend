const { suggestCategories } = require('./ebayTaxonomyService');
const lists = require('./categoryListService');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * The category of a product when eBay's Taxonomy service cannot give one: its daily limit is used up (about 5,000 calls for ALL sellers).
 *
 * eBay's own suggestion is always tried first (free, and the most exact). Only when eBay says its limit is reached, and the admin has uploaded
 * the category list of that marketplace (Admin Panel -> Categories), the AI chooses from that REAL list: services/categoryListService.js finds
 * the categories that look like the title, the AI picks one of them, and an ID that is not in the list is never accepted. Costs the seller
 * ACTION_COSTS.AI_CATEGORY credits (the admin sets it), given back when no category is found.
 */

const MAX_CANDIDATES = 40;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const picks = new Map(); // "marketplace|title words" -> { pick, at }: the same product words are not asked again (and cost nothing)

const SYSTEM = `You choose the eBay category for a product. You get the product title and a list of real eBay categories, one per line as "ID | Category path". Choose the ONE most specific category where a seller would list this exact product.
Answer with JSON only, nothing else:
{"id":"<an ID copied from the list>"}
If no category in the list fits the product, answer:
{"id":null,"search":"3 to 6 words that name what the product is, in the words eBay uses for its categories"}
Never make up an ID, and never choose a category that is not in the list.`;

function promptFor(domain, title, candidates) {
  return 'eBay site: ' + domain + '\nProduct title: ' + String(title).slice(0, 300) + '\n\nCategories:\n' + (candidates.length ? candidates.map((c) => c.id + ' | ' + c.path).join('\n') : '(none matched the title)');
}

/** The AI's answer as { id, search }: JSON, or (when it only wrote a number) that number. */
function parseAnswer(text) {
  const raw = String(text || '');
  const json = raw.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const o = JSON.parse(json[0]);
      return { id: o.id === null || o.id === undefined ? '' : String(o.id).trim(), search: typeof o.search === 'string' ? o.search.trim().slice(0, 120) : '' };
    } catch (_) { /* not JSON: look for a number below */ }
  }
  const digits = raw.match(/\b\d{2,12}\b/);
  return { id: digits ? digits[0] : '', search: '' };
}

/**
 * Chooses a category of the marketplace's list for a title: at most two AI calls (the second only when the first found nothing fitting and
 * gave words to search with). @returns {{ id, path, name, usage }} @throws when nothing in the list fits
 */
async function chooseFromList(index, domain, title) {
  const { askClaude } = require('./aiService');
  const usage = { inputTokens: 0, outputTokens: 0, model: null };
  let candidates = lists.shortlist(index, title, MAX_CANDIDATES);
  for (let round = 0; round < 2; round += 1) {
    const ai = await askClaude({ system: SYSTEM, prompt: promptFor(domain, title, candidates), maxTokens: 80 });
    usage.inputTokens += ai.inputTokens || 0;
    usage.outputTokens += ai.outputTokens || 0;
    usage.model = ai.model || usage.model;
    const answer = parseAnswer(ai.text);
    const chosen = answer.id && candidates.find((c) => c.id === answer.id);
    if (chosen) return { id: chosen.id, path: chosen.path, name: chosen.name, usage };
    if (round === 0 && answer.search) {
      // The title's own words did not lead to the right categories: search with the words the AI used for the product, keeping some of the first list.
      const more = lists.shortlist(index, answer.search, MAX_CANDIDATES - 12);
      const seen = new Set(more.map((c) => c.id));
      candidates = [...more, ...candidates.filter((c) => !seen.has(c.id)).slice(0, 12)];
      continue;
    }
    break;
  }
  const err = new Error('no category in the list fits this product.');
  err.usage = usage;
  throw err;
}

const wordsKey = (marketplaceId, title) => String(marketplaceId).toUpperCase() + '|' + lists.tokens(title).slice(0, 10).join(' ');

const asSuggestion = (pick, creditsUsed) => {
  const s = { categoryId: pick.id, categoryName: pick.name, fullPath: pick.path };
  return { topSuggestion: s, suggestions: [s], source: 'ai', creditsUsed };
};

/**
 * Called when eBay's category service said its limit is reached (limitErr). Throws limitErr itself when the backup is not available (the admin
 * has not uploaded this marketplace's list, the AI switch is off, no AI key); throws a longer message of the same kind when it was tried and
 * found nothing or the seller has too few credits.
 */
async function backupSuggestion(userId, title, marketplaceId, limitErr) {
  const { aiConfigured } = require('./aiService');
  const { getAiSettings } = require('../models/settingsModel');
  if (!aiConfigured() || !(await getAiSettings()).aiCategoryEnabled) throw limitErr;
  const index = await lists.getIndex(marketplaceId);
  if (!index) throw limitErr;

  const key = wordsKey(marketplaceId, title);
  const known = picks.get(key);
  if (known && Date.now() - known.at < CACHE_MS) return asSuggestion(known.pick, 0);

  const { withCredits } = require('./creditService');
  const AiUsage = require('../models/schemas/AiUsage');
  const domain = lists.DOMAINS[String(marketplaceId).toUpperCase()] || String(marketplaceId);
  const cost = Number(ACTION_COSTS.AI_CATEGORY || 0);
  const fail = (reason, extra) => Object.assign(new Error(limitErr.message + ' The AI category backup could not help: ' + reason), { statusCode: limitErr.statusCode, limitReached: true, aiBackup: 'failed', ...extra });
  let pick;
  let usage = null;
  try {
    pick = await withCredits(userId, cost, async () => {
      try { return await chooseFromList(index, domain, title); } catch (err) { usage = err.usage || null; throw err; }
    });
    usage = pick.usage;
  } catch (err) {
    if (err.outOfCredits) throw fail('it needs ' + cost + ' credit' + (cost === 1 ? '' : 's') + ' and there are not enough. Buy credits, or try again after the limit restarts.', { outOfCredits: true });
    AiUsage.create({ userId, kind: 'category', ok: false, credits: 0, model: usage && usage.model, inputTokens: usage ? usage.inputTokens : 0, outputTokens: usage ? usage.outputTokens : 0 }).catch(() => {});
    throw fail(err.message || 'the AI request failed.');
  }
  AiUsage.create({ userId, kind: 'category', ok: true, credits: cost, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }).catch(() => {});
  picks.set(key, { pick: { id: pick.id, path: pick.path, name: pick.name }, at: Date.now() });
  if (picks.size > CACHE_MAX) picks.delete(picks.keys().next().value);
  return asSuggestion(pick, cost);
}

/**
 * eBay's suggestion for a title (services/ebayTaxonomyService.js suggestCategories), and the AI backup above when eBay's limit is reached.
 * The answer has the same shape; `source: 'ai'` and `creditsUsed` are added when the backup chose it.
 */
async function suggestCategoriesWithBackup(userId, title, marketplaceId) {
  try {
    return await suggestCategories(null, title, marketplaceId);
  } catch (err) {
    if (!err || !err.limitReached || err.aiBackup) throw err;
    return backupSuggestion(userId, title, marketplaceId, err);
  }
}

module.exports = { suggestCategoriesWithBackup, parseAnswer, _picks: picks };
