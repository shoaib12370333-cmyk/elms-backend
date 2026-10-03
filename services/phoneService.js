/**
 * The phone number typed at sign-up (or added later): checked, then stored in one fixed shape. There is NO verification (no SMS, no code) -
 * the number is only checked for being a real, possible number of the chosen country, so `1111111111` or `123` are refused, and it is
 * kept for the admins (Admin -> Users) as account contact. See PRODUCTION-SETUP.md "Phone number at sign-up".
 *
 * Stored as E.164 (`+923001234567`) plus the country (`PK`) and a spaced display form (`+92 300 1234567`).
 *
 * The library's default ("min") metadata is used on purpose: it checks the length and the leading digits of each country but not the
 * finer per-type ranges, so a real number from a range allocated recently is not refused (the number is required to sign up, and a wrong
 * refusal locks a real person out, while nothing here can prove a number is theirs anyway).
 */
const { parsePhoneNumberFromString, getCountries, getCountryCallingCode } = require('libphonenumber-js');

const COUNTRIES = new Set(getCountries());
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { regionNames = null; }
const countryName = (iso) => { try { return (regionNames && regionNames.of(iso)) || iso; } catch (_) { return iso; } };

const MAX_RAW = 200;   // anything longer is not a phone number and is not even cleaned
const MAX_INPUT = 40;  // longest number once cleaned

// People type their own digits: Urdu / Arabic / Bengali / Hindi ... keyboards give a different character for each 0-9. These are the first
// characters of each script's block of ten digits; a digit of one of them is turned into 0-9 (full-width digits are handled by NFKC).
const DIGIT_BLOCKS = [0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x17E0, 0x1810];
const toAsciiDigits = (s) => s.replace(/\p{Nd}/gu, (ch) => {
  const cp = ch.codePointAt(0);
  const start = DIGIT_BLOCKS.find((b) => cp >= b && cp <= b + 9);
  return start === undefined ? ch : String(cp - start);
});

/**
 * What was typed, tidied: compatibility forms folded (full-width digits and plus, non-breaking spaces), invisible format marks removed (a number
 * copied from a phone's contacts or WhatsApp carries left-to-right marks), every dash and space made plain, every script's digits made 0-9.
 */
function cleanTyped(raw) {
  const folded = String(raw).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\p{Pd}\u2212]/gu, '-').replace(/[\p{Z}\s]/gu, ' ');
  return toAsciiDigits(folded).trim();
}

/**
 * @param {{ phoneCountry?: unknown, phone?: unknown }} input what the person chose / typed
 * @returns {{ ok: true, phone: string, phoneCountry: string, phoneDisplay: string } | { ok: false, message: string, field: 'phoneCountry'|'phone' }}
 */
function normalizePhone({ phoneCountry, phone } = {}) {
  const iso = typeof phoneCountry === 'string' ? phoneCountry.trim().toUpperCase() : '';
  if (!COUNTRIES.has(iso)) return { ok: false, field: 'phoneCountry', message: 'Please choose the country of your phone number.' };

  if (typeof phone === 'string' && phone.length > MAX_RAW) return { ok: false, field: 'phone', message: 'That phone number is too long.' };
  const typed = typeof phone === 'string' ? cleanTyped(phone) : '';
  if (!typed) return { ok: false, field: 'phone', message: 'Please enter your phone number.' };
  if (typed.length > MAX_INPUT) return { ok: false, field: 'phone', message: 'That phone number is too long.' };
  if (/[a-z]/i.test(typed) || !/^[+\d\s().-]+$/.test(typed)) {
    return { ok: false, field: 'phone', message: 'A phone number can only have digits, spaces and + ( ) - . characters.' };
  }

  let parsed = null;
  try { parsed = parsePhoneNumberFromString(typed, iso); } catch (_) { parsed = null; }
  // a possible AND valid number of a real country (the chosen one, or the one a typed "+code" names)
  if (!parsed || !parsed.country || !parsed.isValid()) {
    return { ok: false, field: 'phone', message: `That does not look like a valid phone number for ${countryName(iso)}. Check it and try again.` };
  }
  // Countries share a calling code (+44 is the UK, Guernsey, Jersey and the Isle of Man; +1 is the US, Canada and more): the person's own choice is
  // kept among them, so a UK mobile is not filed under Guernsey. A typed "+code" of ANOTHER calling code wins (the number says where it is from).
  const sameCode = String(parsed.countryCallingCode) === String(getCountryCallingCode(iso));
  return { ok: true, phone: parsed.number, phoneCountry: sameCode ? iso : parsed.country, phoneDisplay: parsed.formatInternational() };
}

module.exports = { normalizePhone, countryName, cleanTyped };
