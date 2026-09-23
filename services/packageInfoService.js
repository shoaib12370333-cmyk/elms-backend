/**
 * Package weight / size for eBay's inventory item (`packageWeightAndSize`).
 *
 * eBay needs the weight to price a listing whose fulfillment policy uses CALCULATED shipping
 * (the buyer's postage is worked out from weight, size and ZIP), and rejects the publish without it.
 * Amazon product pages carry it as free text in the specifications - "Item Weight: 1.2 pounds",
 * "Package Dimensions: 8.5 x 6 x 3 inches; 9.6 ounces" - so it is read from there. A seller can also
 * add a custom specification named "Package Weight" (e.g. "1.5 lb") in the draft editor.
 */

const WEIGHT_UNITS = [
  [/^(kilograms?|kgs?|kg)$/i, 'KILOGRAM'],
  [/^(pounds?|lbs?|lb)$/i, 'POUND'],
  [/^(ounces?|ozs?|oz)$/i, 'OUNCE'],
  [/^(grams?|gms?|g)$/i, 'GRAM'],
];
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const WEIGHT_RE = new RegExp(NUM + String.raw`\s*(kilograms?|kgs?|kg|pounds?|lbs?|lb|ounces?|ozs?|oz|grams?|gms?|g)\b`, 'i');
const DIM_RE = new RegExp(NUM + String.raw`\s*[x×]\s*` + NUM + String.raw`\s*[x×]\s*` + NUM + String.raw`\s*(inches|inch|in|"|centimeters?|cm|millimeters?|mm)?`, 'i');

const toNumber = (s) => Number(String(s).replace(/,/g, ''));
const round2 = (n) => Math.round(n * 100) / 100;

function parseWeight(text) {
  const m = String(text || '').match(WEIGHT_RE);
  if (!m) return null;
  const value = toNumber(m[1]);
  const unit = (WEIGHT_UNITS.find(([re]) => re.test(m[2])) || [])[1];
  return unit && value > 0 ? { value: round2(value), unit } : null;
}

function parseDimensions(text) {
  const m = String(text || '').match(DIM_RE);
  if (!m || !m[4]) return null;
  let [l, w, h] = [toNumber(m[1]), toNumber(m[2]), toNumber(m[3])];
  const raw = m[4].toLowerCase();
  let unit;
  if (/^(inches|inch|in|")$/.test(raw)) unit = 'INCH';
  else if (/^centimeters?$|^cm$/.test(raw)) unit = 'CENTIMETER';
  else { unit = 'CENTIMETER'; [l, w, h] = [l / 10, w / 10, h / 10]; } // millimetres
  if (![l, w, h].every((n) => n > 0)) return null;
  return { length: round2(l), width: round2(w), height: round2(h), unit };
}

/**
 * @param {Array<{name:string,value:string}>} specifications - Amazon "technical specifications"
 * @returns {{ weight?: {value:number,unit:string}, dimensions?: {length:number,width:number,height:number,unit:string} }}
 */
function extractPackageInfo(specifications) {
  const specs = (Array.isArray(specifications) ? specifications : [])
    .filter((s) => s && s.name && s.value)
    .map((s) => ({ name: String(s.name).toLowerCase(), value: String(s.value) }));
  const named = (re) => specs.filter((s) => re.test(s.name));

  // Weight: the packaged weight first, then the item's own.
  let weight = null;
  for (const re of [/package weight|shipping weight/, /^(item |product )?weight$|item weight|product weight/, /package dimensions/, /dimensions/]) {
    for (const s of named(re)) {
      // In "Package Dimensions" the weight follows the sizes after a ";" - read only that part.
      weight = parseWeight(/dimensions/.test(s.name) ? s.value.split(';').slice(1).join(';') : s.value);
      if (weight) break;
    }
    if (weight) break;
  }

  let dimensions = null;
  for (const re of [/package dimensions/, /product dimensions|item dimensions|dimensions/]) {
    for (const s of named(re)) {
      dimensions = parseDimensions(s.value);
      if (dimensions) break;
    }
    if (dimensions) break;
  }

  const info = {};
  if (weight) info.weight = weight;
  if (dimensions) info.dimensions = dimensions;
  return info;
}

/** eBay's `packageWeightAndSize` object, or null when there is no weight (dimensions alone are not enough for eBay). */
function toEbayPackageWeightAndSize(info) {
  if (!info || !info.weight) return null;
  const out = { weight: { value: info.weight.value, unit: info.weight.unit } };
  if (info.dimensions) out.dimensions = { ...info.dimensions };
  return out;
}

module.exports = { extractPackageInfo, toEbayPackageWeightAndSize, parseWeight, parseDimensions };
