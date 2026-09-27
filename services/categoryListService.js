const zlib = require('zlib');
const mongoose = require('mongoose');
const EbayCategoryList = require('../models/schemas/EbayCategoryList');
const { MARKETPLACES, normalizeMarketplaceId, assertSupportedMarketplace } = require('../config/ebayMarketplaces');

/**
 * A category list per eBay marketplace, from the "Category IDs" CSV of that eBay site (columns CategoryID and Category Path; every row is a
 * final, "leaf" category, the only kind eBay accepts a listing in). The admin uploads one per country (Admin Panel -> Categories).
 * It lets ELMS pick a category from a REAL list without asking eBay's Taxonomy API (see services/aiCategoryService.js): this file finds the
 * categories that look like a product title, the AI chooses among them.
 */

const DOMAINS = {
  EBAY_US: 'ebay.com', EBAY_GB: 'ebay.co.uk', EBAY_DE: 'ebay.de', EBAY_CA: 'ebay.ca', EBAY_AU: 'ebay.com.au', EBAY_FR: 'ebay.fr', EBAY_IT: 'ebay.it', EBAY_ES: 'ebay.es',
  EBAY_AT: 'ebay.at', EBAY_BE: 'ebay.be', EBAY_CH: 'ebay.ch', EBAY_HK: 'ebay.com.hk', EBAY_IE: 'ebay.ie', EBAY_MY: 'ebay.com.my', EBAY_NL: 'ebay.nl',
  EBAY_PH: 'ebay.ph', EBAY_PL: 'ebay.pl', EBAY_SG: 'ebay.com.sg', EBAY_TW: 'ebay.com.tw',
};
const MAIN = ['EBAY_US', 'EBAY_GB', 'EBAY_DE', 'EBAY_CA', 'EBAY_AU', 'EBAY_FR', 'EBAY_IT', 'EBAY_ES'];
const MIN_ROWS = 20; // anything smaller is not a category list
const MAX_ROWS = 200000;
const MAX_PATH = 600;
const RECHECK_MS = 10 * 60 * 1000; // a loaded list: is it still the newest? asked at most this often
const MISSING_RECHECK_MS = 60 * 1000; // no list for a marketplace: asked again after this long

const dbReady = () => !!(mongoose.connection && mongoose.connection.readyState === 1);

// ---------------------------------------------------------------- the CSV

/** CSV text into rows of fields. Quotes around a field, "" for a quote inside it, and (as eBay's own file has, e.g. `18" Doll`) a lone quote inside a quoted field is kept as text. */
function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') { field += '"'; i += 1; } else if (next === undefined || next === delimiter || next === '\n' || next === '\r') quoted = false;
        else field += '"';
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * eBay's category CSV into { rows: [{ id, path }], skipped, duplicates }. Throws with a message an admin can act on when the file is not a
 * category list. The header is read by name (CategoryID, Category Path); a file with no header whose first column is a number is read as id, path.
 */
function parseCategoryCsv(input) {
  const text = String(input || '').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The file is empty.');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',');
  const all = parseCsvRows(text, delimiter).filter((r) => r.some((f) => String(f).trim() !== ''));
  if (!all.length) throw new Error('The file is empty.');

  let idCol = 0;
  let pathCol = 1;
  let start = 0;
  const names = all[0].map((h) => String(h).toLowerCase().replace(/[^a-z]/g, ''));
  const hasHeader = !/^\d+$/.test(String(all[0][0]).trim());
  if (hasHeader) {
    idCol = names.findIndex((h) => h === 'categoryid' || h === 'id');
    pathCol = names.findIndex((h) => h === 'categorypath' || h === 'path' || h === 'categoryname');
    if (idCol < 0 || pathCol < 0) throw new Error('This does not look like eBay\'s category list. The first row should have the columns "CategoryID" and "Category Path".');
    start = 1;
  }

  const byId = new Map();
  let skipped = 0;
  let duplicates = 0;
  for (let i = start; i < all.length; i += 1) {
    const id = String(all[i][idCol] === undefined ? '' : all[i][idCol]).trim();
    const path = String(all[i][pathCol] === undefined ? '' : all[i][pathCol]).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^\d{1,12}$/.test(id) || !path || path.length > MAX_PATH) { skipped += 1; continue; }
    if (byId.has(id)) duplicates += 1;
    byId.set(id, path);
  }
  if (byId.size < MIN_ROWS) throw new Error('Only ' + byId.size + ' category rows were found. This does not look like eBay\'s full category list.');
  if (byId.size > MAX_ROWS) throw new Error('The file has more than ' + MAX_ROWS.toLocaleString('en-US') + ' categories. This does not look like an eBay category list.');
  return { rows: [...byId.entries()].map(([id, path]) => ({ id, path })), skipped, duplicates };
}

const encodeRows = (rows) => zlib.gzipSync(Buffer.from(rows.map((r) => r.id + '\t' + r.path).join('\n'), 'utf8'), { level: 9 });
function decodeRows(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from((data && (data.buffer || data)) || []);
  return zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('\t');
    return { id: line.slice(0, at), path: line.slice(at + 1) };
  });
}

// ---------------------------------------------------------------- finding the categories that look like a title

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'with', 'in', 'on', 'to', 'by', 'at', 'or', 'from', 'your', 'you', 'is', 'it', 'this', 'that', 'other', 'others', 'misc', 'new', 'pcs', 'pc']);

// Words of a title that say little about WHAT the product is (colours, sizes, counts): they count a quarter as much when categories are matched.
const NOISE = new Set(['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'brown', 'grey', 'gray', 'silver', 'gold', 'size', 'large', 'small', 'medium', 'xl', 'xxl', 'set', 'pack', 'piece', 'count', 'inch', 'cm', 'mm', 'ml', 'oz', 'kg', 'lb', 'pair', 'man', 'woman', 'kid']);
const IRREGULAR = { mice: 'mouse', men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth', geese: 'goose', knives: 'knife', shelves: 'shelf', leaves: 'leaf', wolves: 'wolf' };

function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}
const stem = (w) => { const r = IRREGULAR[w] || singular(w); return IRREGULAR[r] || r; };

/** Words of a text, lower case, no accents, singular, without filler words ("Kettles & the Teapots" -> kettle, teapot). */
function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem).filter((t) => t.length > 1 && !STOP.has(t));
}
const unique = (list) => [...new Set(list)];

function buildIndex(rows) {
  const cats = rows.map((r) => {
    const parts = r.path.split(' > ');
    const name = parts[parts.length - 1];
    const leaf = unique(tokens(name));
    const anc = unique(tokens(parts.slice(0, -1).join(' '))).filter((t) => !leaf.includes(t));
    return { id: r.id, path: r.path, name, leaf, anc };
  });
  const postings = new Map(); // word -> the categories that have it (in the name or above it)
  cats.forEach((c, i) => { for (const t of [...c.leaf, ...c.anc]) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push(i); } });
  return { cats, postings, byId: new Map(cats.map((c) => [c.id, c])) };
}

/**
 * The categories that look most like a text (a product title, or what the AI called the product): a word counts more the rarer it is among the
 * categories, and more when it is in the category's own name than in a category above it; a category whose whole name is covered comes first.
 * A part of the list is kept for the categories that carry each single word of the title, so a product word buried under others ("mouse" in a
 * title full of "wireless" and "master") still has its categories in the list.
 * @returns {Array<{ id, path, name, score }>} best first
 */
function shortlist(index, text, limit = 40) {
  if (!index) return [];
  const words = unique(tokens(text)).slice(0, 24);
  const total = index.cats.length;
  const score = new Map();
  const leafHits = new Map();
  words.forEach((w, pos) => {
    const list = index.postings.get(w);
    if (!list) return;
    const weight = (pos < 12 ? 1 : 0.6) * (NOISE.has(w) ? 0.25 : 1) * Math.log(1 + total / list.length);
    for (const i of list) {
      const inName = index.cats[i].leaf.includes(w);
      score.set(i, (score.get(i) || 0) + weight * (inName ? 3 : 1));
      if (inName) leafHits.set(i, (leafHits.get(i) || 0) + 1);
    }
  });
  const ranked = [];
  for (const [i, s] of score) {
    const c = index.cats[i];
    const covered = c.leaf.length ? (leafHits.get(i) || 0) / c.leaf.length : 0;
    ranked.push({ id: c.id, path: c.path, name: c.name, score: s * (0.6 + 0.4 * covered) });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const main = Math.ceil(limit * 0.6);
  const out = ranked.slice(0, main);
  const seen = new Set(out.map((c) => c.id));
  for (const w of words.filter((x) => !NOISE.has(x)).slice(0, 12)) {
    let taken = 0;
    for (const c of ranked) {
      if (out.length >= limit || taken >= 3) break;
      if (seen.has(c.id) || !index.byId.get(c.id).leaf.includes(w)) continue;
      out.push(c); seen.add(c.id); taken += 1;
    }
  }
  for (const c of ranked) { if (out.length >= limit) break; if (!seen.has(c.id)) { out.push(c); seen.add(c.id); } }
  return out;
}

// ---------------------------------------------------------------- the lists (one per marketplace)

const cache = new Map(); // marketplaceId -> { index, stamp, at }
const loading = new Map();

async function loadIndex(id) {
  const meta = await EbayCategoryList.findOne({ marketplaceId: id }).select('updatedAt').lean();
  const hit = cache.get(id);
  if (!meta) { cache.set(id, { index: null, stamp: 0, at: Date.now() }); return null; }
  const stamp = +new Date(meta.updatedAt);
  if (hit && hit.index && hit.stamp === stamp) { hit.at = Date.now(); return hit.index; }
  const doc = await EbayCategoryList.findOne({ marketplaceId: id });
  if (!doc) { cache.set(id, { index: null, stamp: 0, at: Date.now() }); return null; }
  const index = buildIndex(decodeRows(doc.data));
  cache.set(id, { index, stamp: +new Date(doc.updatedAt), at: Date.now() });
  return index;
}

/** The searchable list of a marketplace, or null when the admin has not uploaded one. Kept in memory; a new upload is noticed within 10 minutes (at once on this server). */
async function getIndex(marketplaceId) {
  const id = normalizeMarketplaceId(marketplaceId);
  if (!MARKETPLACES[id]) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.index ? RECHECK_MS : MISSING_RECHECK_MS)) return hit.index;
  if (!dbReady()) return hit ? hit.index : null;
  if (!loading.has(id)) loading.set(id, loadIndex(id).finally(() => loading.delete(id)));
  return loading.get(id);
}

/** Checks a category number against the marketplace's list: { id, path, name } when it is a category of that list. */
async function categoryById(marketplaceId, categoryId) {
  const index = await getIndex(marketplaceId);
  const c = index && index.byId.get(String(categoryId));
  return c ? { id: c.id, path: c.path, name: c.name } : null;
}

/** Saves (or replaces) the category list of a marketplace from the CSV text. @returns {{ marketplaceId, count, skipped, duplicates }} */
async function saveCategoryList(marketplaceId, csvText, { filename = '' } = {}) {
  const id = assertSupportedMarketplace(marketplaceId);
  const parsed = parseCategoryCsv(csvText);
  await EbayCategoryList.findOneAndUpdate(
    { marketplaceId: id },
    { $set: { data: encodeRows(parsed.rows), count: parsed.rows.length, filename: String(filename || '').slice(0, 200) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cache.delete(id);
  return { marketplaceId: id, count: parsed.rows.length, skipped: parsed.skipped, duplicates: parsed.duplicates };
}

async function deleteCategoryList(marketplaceId) {
  const id = assertSupportedMarketplace(marketplaceId);
  const res = await EbayCategoryList.deleteOne({ marketplaceId: id });
  cache.delete(id);
  return { marketplaceId: id, removed: !!(res && res.deletedCount) };
}

/** Every eBay marketplace ELMS supports with what is uploaded for it (the main sites first). */
async function listCategoryLists() {
  const rows = await EbayCategoryList.find({}).select('-data').lean();
  const byId = new Map(rows.map((r) => [r.marketplaceId, r]));
  const order = [...MAIN, ...Object.keys(MARKETPLACES).filter((m) => !MAIN.includes(m)).sort()];
  return order.map((id) => {
    const r = byId.get(id);
    return {
      marketplaceId: id, country: MARKETPLACES[id].country, currency: MARKETPLACES[id].currency, domain: DOMAINS[id] || '',
      uploaded: !!r, count: r ? r.count : 0, filename: r ? r.filename || '' : '', updatedAt: r ? r.updatedAt : null,
    };
  });
}

module.exports = { parseCategoryCsv, saveCategoryList, deleteCategoryList, listCategoryLists, getIndex, categoryById, shortlist, tokens, buildIndex, DOMAINS, _cache: cache };
