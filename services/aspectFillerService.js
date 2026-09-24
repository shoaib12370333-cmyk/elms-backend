const { askClaude } = require('./aiService');

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Every value eBay allows for an aspect (eBay's list can be longer than the 100 choices the editor receives).
const allowedOf = (a) => (Array.isArray(a.allValues) && a.allValues.length ? a.allValues : Array.isArray(a.values) ? a.values : []).map(String);

/**
 * Fills the item specifics of an eBay category from what we know about the product.
 * Required aspects come first. Values that eBay lists for an aspect must be chosen from that list.
 * @param {object} p { title, description, bulletPoints, specifications, categoryName, aspects: [{name, required, usage, cardinality, values}], existing: {name: [values]} }
 * @returns {Promise<{ text: string, data: { values: Object<string,string[]>, filled: number }, usage: object }>}
 */
async function fillItemSpecifics({ title, description, bulletPoints, specifications, categoryName, aspects, existing = {} }) {
  const list = (Array.isArray(aspects) ? aspects : [])
    .filter((a) => a && a.name)
    .map((a) => ({ name: String(a.name), required: !!a.required, usage: a.usage || (a.required ? 'REQUIRED' : 'OPTIONAL'), multi: a.cardinality === 'MULTI', values: allowedOf(a), free: a.mode === 'FREE_TEXT' }))
    .sort((x, y) => (y.required - x.required) || ((y.usage === 'RECOMMENDED') - (x.usage === 'RECOMMENDED')))
    .slice(0, 45);
  if (!list.length) return { text: '', data: { values: {}, filled: 0 }, usage: null };

  const facts = [
    `Title: ${title}`,
    categoryName ? `eBay category: ${categoryName}` : '',
    (bulletPoints || []).length ? `Feature bullets:\n${bulletPoints.slice(0, 12).map((b) => '- ' + String(b)).join('\n')}` : '',
    (specifications || []).length ? `Specifications:\n${specifications.slice(0, 40).map((s) => `${s.name || s.label}: ${s.value ?? ''}`).join('\n')}` : '',
    description ? `Description:\n${String(description).slice(0, 2500)}` : '',
  ].filter(Boolean).join('\n');

  const spec = list.map((a) => {
    const kind = a.required ? 'REQUIRED' : a.usage === 'RECOMMENDED' ? 'recommended' : 'optional';
    // The prompt shows the first 60 choices; the answer is checked against the whole list.
    // A FREE_TEXT aspect only suggests values: the seller (or the AI) may write another one.
    const allowed = a.values.length && !a.free
      ? ` | choose from: ${a.values.slice(0, 60).join(' ; ')}${a.values.length > 60 ? ' ; (or another standard eBay value that fits)' : ''}`
      : a.values.length ? ` | free text, max 65 characters (usual values: ${a.values.slice(0, 25).join(' ; ')})` : ' | free text, max 65 characters';
    return `- ${a.name} (${kind}${a.multi ? ', can have several values' : ''})${allowed}`;
  }).join('\n');

  const prompt = [
    'Fill in the eBay item specifics for this product.',
    'Use ONLY facts stated in the product information. Never guess sizes, materials, compatibility or numbers.',
    'When an aspect has a "choose from" list, the value MUST be copied exactly from that list. If no listed value fits, leave the aspect out.',
    'Fill as many aspects as the facts support, REQUIRED ones first. For a REQUIRED aspect that the facts do not answer: Brand -> "Unbranded"; every other one -> "Does not apply".',
    'Leave optional aspects out when unknown. Values must be short (65 characters max). Several values only where the aspect allows several.',
    'Reply with ONLY a JSON object: {"Aspect name": "value"} or {"Aspect name": ["value one","value two"]}. No commentary.',
    '',
    'Product information:',
    facts,
    '',
    'Aspects to fill:',
    spec,
  ].join('\n');

  const result = await askClaude({ prompt, maxTokens: 1400 });
  const start = result.text.indexOf('{');
  const end = result.text.lastIndexOf('}');
  let parsed = {};
  try { parsed = JSON.parse(result.text.slice(start, end + 1)); } catch (_) {
    const err = new Error('The AI answer could not be read. Please try again.');
    err.statusCode = 502;
    throw err;
  }

  const byName = new Map(list.map((a) => [norm(a.name), a]));
  const values = {};
  for (const [rawName, rawVal] of Object.entries(parsed || {})) {
    const a = byName.get(norm(rawName));
    if (!a) continue;
    const already = existing[a.name];
    if (Array.isArray(already) ? already.some((x) => String(x).trim()) : String(already || '').trim()) continue; // never overwrite what the seller typed
    let vals = (Array.isArray(rawVal) ? rawVal : [rawVal]).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (a.values.length) {
      const allowed = new Map(a.values.map((v) => [norm(v), v]));
      // Only a "choose from" aspect drops what is not on the list; a free-text one keeps the AI's own wording.
      vals = a.free ? vals.map((v) => allowed.get(norm(v)) || v.slice(0, 65)) : vals.map((v) => allowed.get(norm(v))).filter(Boolean);
    } else {
      vals = vals.map((v) => v.slice(0, 65));
    }
    if (!a.multi) vals = vals.slice(0, 1);
    vals = [...new Set(vals)].slice(0, 30);
    if (vals.length) values[a.name] = vals;
  }
  return { text: JSON.stringify(values), data: { values, filled: Object.keys(values).length }, usage: result };
}

module.exports = { fillItemSpecifics };
