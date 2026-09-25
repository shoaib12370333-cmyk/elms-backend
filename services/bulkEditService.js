const { normalizeRule } = require('./pricingService');
const { priceByRule } = require('./importPricingService');

/**
 * Bulk edit of drafts: one set of changes (price, quantity, title, brand, tags, monitoring, location, policies) applied to every selected
 * draft. Only fields ELMS really has are here. Everything is checked BEFORE anything is saved, a draft that cannot take the change is
 * skipped with the reason (never half-edited, never silently cut short), and `dryRun` returns exactly what would change without saving.
 */
const LIMITS = Object.freeze({ titleMax: 80, brandMax: 65, quantityMin: 1, quantityMax: 999, tagMax: 40, tagsMax: 30, findMax: 80, textMax: 80 });
const TITLE_OPS = ['replace', 'prefix', 'suffix', 'case'];
const TAG_MODES = ['add', 'remove', 'replace', 'clear'];
const CASES = ['upper', 'lower', 'title'];
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const POSTAL_CODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;
const POLICY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const cents = (v) => Math.round(Number(v) * 100 + 1e-9);
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words start with a capital, the rest is small ("nike AIR max" -> "Nike Air Max"). */
function titleCase(text) {
  return text.toLowerCase().replace(/(^|[\s\-/(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
}

/** The new title for one draft. Returns the text (already tidied); the length limit is checked by the caller. */
function applyTitleOp(title, op) {
  const t = String(title == null ? '' : title);
  let out = t;
  if (op.op === 'replace') {
    const re = new RegExp(escapeRegExp(op.find), op.caseSensitive ? 'g' : 'gi');
    out = t.replace(re, () => op.with);
  } else if (op.op === 'prefix') out = op.text + ' ' + t;
  else if (op.op === 'suffix') out = t + ' ' + op.text;
  else if (op.op === 'case') out = op.case === 'upper' ? t.toUpperCase() : op.case === 'lower' ? t.toLowerCase() : titleCase(t);
  return clean(out);
}

function applyTags(current, change) {
  const have = Array.isArray(current) ? current : [];
  let next;
  if (change.mode === 'clear') next = [];
  else if (change.mode === 'replace') next = change.tags;
  else if (change.mode === 'add') next = [...have, ...change.tags];
  else {
    const drop = new Set(change.tags.map((x) => x.toLowerCase()));
    next = have.filter((x) => !drop.has(String(x).toLowerCase()));
  }
  return Array.from(new Set(next)).slice(0, LIMITS.tagsMax);
}

/**
 * Checks the whole request and returns it in a clean shape. Throws (status 400) with the reason when something is wrong: nothing is
 * corrected by itself and nothing is saved.
 */
async function validateChanges(raw, { userId, getSavedRule }) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const changes = {};

  if (src.price !== undefined) {
    const p = src.price || {};
    let rule;
    if (p.mode === 'saved') {
      const stored = await getSavedRule(userId);
      if (!stored) throw bad('You have no saved pricing rule yet. Set it in Settings > Pricing, or choose "Set the price here".');
      const checked = normalizeRule(stored);
      if (!checked.rule) throw bad('Your saved pricing rule is not valid (' + checked.errors[0] + ') Open Settings > Pricing and save it again.');
      rule = checked.rule;
    } else if (p.mode === 'custom') {
      const checked = normalizeRule(p.rule);
      if (!checked.rule) throw bad(checked.errors[0]);
      rule = checked.rule;
    } else throw bad('Choose how the price is set: your pricing rule, or the numbers you type.');
    changes.price = { rule: { ...rule, enabled: true } };
  }

  if (src.quantity !== undefined) {
    const q = Number(src.quantity);
    if (String(src.quantity).trim() === '' || !Number.isInteger(q) || q < LIMITS.quantityMin || q > LIMITS.quantityMax) throw bad(`Quantity must be a whole number from ${LIMITS.quantityMin} to ${LIMITS.quantityMax}.`);
    changes.quantity = q;
  }

  if (src.title !== undefined) {
    const t = src.title || {};
    if (!TITLE_OPS.includes(t.op)) throw bad('Choose what to do with the titles.');
    const op = { op: t.op };
    if (t.op === 'replace') {
      op.find = clean(t.find);
      if (!op.find) throw bad('Type the text to find in the titles.');
      if (op.find.length > LIMITS.findMax) throw bad(`The text to find can be at most ${LIMITS.findMax} characters.`);
      op.with = clean(t.with);
      op.caseSensitive = t.caseSensitive === true;
    } else if (t.op === 'prefix' || t.op === 'suffix') {
      op.text = clean(t.text);
      if (!op.text) throw bad('Type the text to add to the titles.');
      if (op.text.length > LIMITS.textMax) throw bad(`The text to add can be at most ${LIMITS.textMax} characters.`);
    } else {
      if (!CASES.includes(t.case)) throw bad('Choose upper case, lower case or title case.');
      op.case = t.case;
    }
    changes.title = op;
  }

  if (src.brand !== undefined) {
    const brand = clean(src.brand);
    if (!brand) throw bad('Type the brand.');
    if (brand.length > LIMITS.brandMax) throw bad(`The brand can be at most ${LIMITS.brandMax} characters (eBay's limit for an item specific).`);
    changes.brand = brand;
  }

  if (src.tags !== undefined) {
    const t = src.tags || {};
    if (!TAG_MODES.includes(t.mode)) throw bad('Choose whether to add, remove, replace or clear the tags.');
    const list = Array.isArray(t.tags) ? t.tags : String(t.tags || '').split(',');
    const tags = Array.from(new Set(list.map((x) => clean(x).slice(0, LIMITS.tagMax)).filter(Boolean)));
    if (t.mode !== 'clear' && !tags.length) throw bad('Type at least one tag.');
    changes.tags = { mode: t.mode, tags };
  }

  for (const key of ['stockMonitoring', 'priceMonitoring']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] !== 'boolean') throw bad('Stock and price monitoring must be on or off.');
    changes[key] = src[key];
  }

  if (src.location !== undefined) {
    const l = src.location || {};
    const location = {};
    if (l.countryLocation !== undefined && String(l.countryLocation).trim() !== '') {
      const c = String(l.countryLocation).trim();
      if (!COUNTRY_CODE.test(c)) throw bad('The item location country must be a 2-letter code such as GB or US.');
      location.countryLocation = c.toUpperCase() === 'UK' ? 'GB' : c.toUpperCase();
    }
    if (l.postalCode !== undefined && String(l.postalCode).trim() !== '') {
      const p = String(l.postalCode).trim();
      if (!POSTAL_CODE.test(p)) throw bad('That postcode does not look right.');
      location.postalCode = p.toUpperCase();
    }
    if (l.locationCity !== undefined && String(l.locationCity).trim() !== '') location.locationCity = clean(l.locationCity).slice(0, 80);
    if (!Object.keys(location).length) throw bad('Type at least the country, city or postcode of the item location.');
    changes.location = location;
  }

  if (src.policies !== undefined) {
    const p = src.policies || {};
    if (p.mode === 'default') changes.policies = { useDynamicPolicies: true };
    else if (p.mode === 'choose') {
      const policies = { useDynamicPolicies: false };
      for (const [key, label] of [['paymentPolicyId', 'payment'], ['fulfillmentPolicyId', 'shipping'], ['returnPolicyId', 'return']]) {
        if (p[key] === undefined || p[key] === null || String(p[key]).trim() === '') continue;
        if (!POLICY_ID.test(String(p[key]).trim())) throw bad('The ' + label + ' policy is not valid.');
        policies[key] = String(p[key]).trim();
      }
      if (Object.keys(policies).length === 1) throw bad('Choose at least one policy.');
      changes.policies = policies;
    } else throw bad('Choose your account default policies, or pick the policies.');
  }

  if (!Object.keys(changes).length) throw bad('Choose at least one thing to change.');
  return changes;
}

const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
const firstValue = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * What the changes do to one draft: { fields } for updateListing and { diff } for the seller, or { error } when the draft cannot take
 * them. Nothing is written here.
 */
async function planDraft(listing, changes, ctx) {
  const fields = {};
  const diff = [];
  const note = (field, from, to) => diff.push({ field, from, to });

  if (changes.title) {
    if (!clean(listing.title)) return { error: 'This draft has no title to change.' };
    const next = applyTitleOp(listing.title, changes.title);
    if (!next) return { error: 'The title would be empty.' };
    if (next.length > LIMITS.titleMax) return { error: `The new title would be ${next.length} characters; eBay allows ${LIMITS.titleMax}.` };
    if (next !== listing.title) { fields.title = next; note('Title', listing.title, next); }
  }

  if (changes.price) {
    let cost = Number(listing.amazon_price);
    let fromImport = false;
    if (!(cost > 0) && listing.import_id) {
      const imp = await ctx.getImportById(ctx.userId, listing.import_id);
      cost = Number(imp && imp.amazon_price);
      if (!(cost > 0)) cost = Number(imp && imp.product && imp.product.price);
      fromImport = cost > 0;
    }
    if (!Number.isFinite(cost) || cost <= 0) return { error: 'No Amazon price is saved for this product.' };
    let priced;
    try {
      priced = await priceByRule({ userId: ctx.userId, price: cost, currency: listing.currency, pricingRule: changes.price.rule });
    } catch (err) {
      return { error: err.message };
    }
    if (!priced) return { error: 'The rule cannot price this product.' };
    const before = listing.sell_price == null ? null : Number(listing.sell_price);
    const ruleChanged = JSON.stringify(listing.pricing_rule || null) !== JSON.stringify(priced.pricingRule);
    if (before === null || cents(before) !== cents(priced.sellPrice) || ruleChanged) {
      Object.assign(fields, { sellPrice: priced.sellPrice, markupPercent: priced.markupPercent, marginAmount: priced.marginAmount, pricingRule: priced.pricingRule });
      if (fromImport) fields.amazonPrice = cost;
      note('Price', before, priced.sellPrice);
    }
  }

  if (changes.quantity !== undefined && Number(listing.quantity) !== changes.quantity) { fields.quantity = changes.quantity; note('Quantity', listing.quantity, changes.quantity); }

  if (changes.brand) {
    let aspects = listing.ebay_aspects && Object.keys(listing.ebay_aspects).length ? listing.ebay_aspects : null;
    if (!aspects && listing.import_id) {
      const imp = await ctx.getImportById(ctx.userId, listing.import_id);
      aspects = imp && imp.product && imp.product.ebayAspects && typeof imp.product.ebayAspects === 'object' ? imp.product.ebayAspects : null;
    }
    const current = firstValue((aspects || {}).Brand);
    if (current !== changes.brand) { fields.ebayAspects = { ...(aspects || {}), Brand: [changes.brand] }; note('Brand', current || null, changes.brand); }
  }

  if (changes.tags) {
    const next = applyTags(listing.tags, changes.tags);
    if (!sameList(next, listing.tags)) { fields.tags = next; note('Tags', (listing.tags || []).join(', ') || null, next.join(', ') || null); }
  }

  if (changes.stockMonitoring !== undefined && (listing.stock_monitoring !== false) !== changes.stockMonitoring) { fields.stockMonitoring = changes.stockMonitoring; note('Stock monitoring', listing.stock_monitoring !== false ? 'On' : 'Off', changes.stockMonitoring ? 'On' : 'Off'); }
  if (changes.priceMonitoring !== undefined && (listing.price_monitoring !== false) !== changes.priceMonitoring) { fields.priceMonitoring = changes.priceMonitoring; note('Price monitoring', listing.price_monitoring !== false ? 'On' : 'Off', changes.priceMonitoring ? 'On' : 'Off'); }

  if (changes.location) {
    const map = { countryLocation: ['Item location country', 'country_location'], locationCity: ['Item location city', 'location_city'], postalCode: ['Item location postcode', 'postal_code'] };
    for (const [key, [label, col]] of Object.entries(map)) {
      if (changes.location[key] !== undefined && (listing[col] || null) !== changes.location[key]) { fields[key] = changes.location[key]; note(label, listing[col] || null, changes.location[key]); }
    }
  }

  if (changes.policies) {
    const p = changes.policies;
    const names = { useDynamicPolicies: ['Policies', null], paymentPolicyId: ['Payment policy', 'payment_policy_id'], fulfillmentPolicyId: ['Shipping policy', 'shipping_policy_id'], returnPolicyId: ['Return policy', 'return_policy_id'] };
    for (const [key, value] of Object.entries(p)) {
      if (key === 'useDynamicPolicies') {
        if (!!listing.use_dynamic_policies !== value) { fields.useDynamicPolicies = value; note('Policies', listing.use_dynamic_policies ? 'Account defaults' : 'Chosen policies', value ? 'Account defaults' : 'Chosen policies'); }
      } else if ((listing[names[key][1]] || null) !== value) { fields[key] = value; note(names[key][0], listing[names[key][1]] || null, value); }
    }
  }

  return { fields, diff };
}

/**
 * Applies `changes` to the drafts `ids`.
 * @returns {Promise<{ results: Array<{ id, title, status: 'changed'|'unchanged'|'skipped', diff?: Array, reason?: string }>, summary: { changed: number, unchanged: number, skipped: number } }>}
 */
async function bulkEdit({ userId, ids, changes, dryRun = false }, deps) {
  const ctx = { userId, getImportById: deps.getImportById };
  const results = [];
  const loaded = new Map();
  const load = async (id) => { if (!loaded.has(id)) loaded.set(id, await deps.getListingById(userId, id)); return loaded.get(id); };
  // Policies belong to one eBay store: chosen policies only make sense when every selected draft is in the same store.
  if (changes.policies && changes.policies.useDynamicPolicies === false) {
    const accounts = new Set();
    for (const id of ids) { const l = await load(id); if (l) accounts.add(l.ebay_account_id || null); }
    if (accounts.size !== 1 || accounts.has(null)) throw bad('The selected drafts are in different stores (or not assigned to one yet). Select drafts from one store to pick their policies, or use the account default policies.');
  }
  for (const id of ids) {
    try {
      const listing = await load(id);
      if (!listing) { results.push({ id, title: null, status: 'skipped', reason: 'Not found.' }); continue; }
      const title = listing.title || listing.sku || id;
      if (!['draft', 'error'].includes(listing.status)) { results.push({ id, title, status: 'skipped', reason: 'Only drafts can be edited here. A live listing is revised on eBay.' }); continue; }
      const plan = await planDraft(listing, changes, ctx);
      if (plan.error) { results.push({ id, title, status: 'skipped', reason: plan.error }); continue; }
      if (!plan.diff.length) { results.push({ id, title, status: 'unchanged', diff: [] }); continue; }
      if (!dryRun) await deps.updateListing(userId, id, plan.fields);
      results.push({ id, title, status: 'changed', diff: plan.diff });
    } catch (err) {
      results.push({ id, title: null, status: 'skipped', reason: err.message || 'Could not update.' });
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { changed: count('changed'), unchanged: count('unchanged'), skipped: count('skipped') } };
}

module.exports = { bulkEdit, validateChanges, applyTitleOp, applyTags, titleCase, LIMITS };
