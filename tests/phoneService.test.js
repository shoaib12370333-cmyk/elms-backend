// services/phoneService.js: the phone number typed at sign-up. There is no SMS / code, so this check is the only quality control: a real,
// valid number of the chosen country, in any of the ways people type it, stored in one shape (E.164 + country + a spaced display form).
const assert = require('assert');
const { normalizePhone, countryName } = require('../services/phoneService');

const ok = (phoneCountry, phone) => { const r = normalizePhone({ phoneCountry, phone }); assert.strictEqual(r.ok, true, phoneCountry + ' ' + phone + ' -> ' + JSON.stringify(r)); return r; };
const bad = (phoneCountry, phone, field) => { const r = normalizePhone({ phoneCountry, phone }); assert.strictEqual(r.ok, false, phoneCountry + ' ' + JSON.stringify(phone) + ' should be refused'); assert.strictEqual(r.field, field, phoneCountry + ' ' + JSON.stringify(phone)); assert.ok(r.message.length > 10); return r; };

// ---------- the same Pakistani number in every way people type it -> one stored form ----------
for (const typed of ['0300 1234567', '03001234567', '300 1234567', '3001234567', '+92 300 1234567', '+92-300-1234567', '0092 300 1234567', '(0300) 123-4567', ' 0300 1234567 ']) {
  assert.deepStrictEqual(ok('PK', typed), { ok: true, phone: '+923001234567', phoneCountry: 'PK', phoneDisplay: '+92 300 1234567' }, typed);
}
// lower-case country is fine
assert.strictEqual(ok('pk', '0300 1234567').phoneCountry, 'PK');

// ---------- numbers of other countries, national and international ----------
assert.deepStrictEqual(ok('US', '(415) 555-2671'), { ok: true, phone: '+14155552671', phoneCountry: 'US', phoneDisplay: '+1 415 555 2671' });
assert.strictEqual(ok('US', '+1 415 555 2671').phone, '+14155552671');
assert.strictEqual(ok('GB', '07911 123456').phone, '+447911123456');
assert.strictEqual(ok('DE', '0151 23456789').phone, '+4915123456789');
assert.strictEqual(ok('IN', '98765 43210').phone, '+919876543210');
assert.strictEqual(ok('AE', '050 123 4567').phone, '+971501234567');
assert.strictEqual(ok('AU', '0412 345 678').phone, '+61412345678');
assert.strictEqual(ok('SA', '055 123 4567').phone, '+966551234567');
assert.strictEqual(ok('NG', '0802 123 4567').phone, '+2348021234567');
assert.strictEqual(ok('IT', '06 1234 5678').phone, '+390612345678', 'the 0 of an Italian landline is part of the number');

// ---------- the person's own country is kept among countries that share a calling code ----------
assert.strictEqual(ok('GB', '07911 123456').phoneCountry, 'GB', 'a UK mobile is not filed under Guernsey');
assert.strictEqual(ok('CA', '(415) 555-2671').phoneCountry, 'CA');
assert.strictEqual(ok('US', '(415) 555-2671').phoneCountry, 'US');
// a typed +code of ANOTHER calling code wins: the number says where it is from
assert.strictEqual(ok('PK', '+1 415 555 2671').phoneCountry, 'US');
assert.strictEqual(ok('PK', '+971 50 123 4567').phone, '+971501234567');

// ---------- junk is refused ----------
for (const junk of ['1111111111', '123', '0000000000', '1234567890', '03001234', '0300 12345678901234', '+92 12']) bad('PK', junk, 'phone');
bad('US', '555-1234', 'phone');
bad('US', '5551234567', 'phone');
bad('PK', '+999 123 456 789', 'phone'); // no such calling code
// letters, extensions and odd characters
for (const typed of ['abc', '0300 1234567 ext 5', '0300-1234567x', 'call me', '0300 1234567; DROP TABLE', '<b>0300</b>', '0300_1234567', '\u96f6\u4e09\u96f6\u96f6', '\u2160\u2161\u2162', '0300\u00b21234567']) bad('PK', typed, 'phone');
assert.match(bad('PK', '0300 1234567 ext 5', 'phone').message, /only have digits/);
assert.match(bad('PK', '1111111111', 'phone').message, /Pakistan/, 'the message names the country that was chosen');
assert.match(bad('PK', '0300'.repeat(20), 'phone').message, /too long/);

// ---------- every way a number really arrives: native digits, copied from contacts / WhatsApp, typographic dashes, odd spaces ----------
const urdu = '\u06F0\u06F3\u06F0\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7';
const arabic = '\u0660\u0663\u0660\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667';
for (const typed of [
  arabic, urdu, arabic.slice(0, 4) + ' ' + urdu.slice(4), // Arabic-Indic, Extended Arabic-Indic (Urdu / Persian), even mixed
  '\u202A+92 300 1234567\u202C', '\u200E+92 300 1234567\u200F', '\uFEFF0300 1234567', '0300 1234567\u200B', // left-to-right marks, BOM, zero-width space
  '0300\u20131234567', '0300\u20111234567', '0300\u20141234567', '0300\u22121234567', // en dash, non-breaking hyphen, em dash, minus sign
  '0300\u00A01234567', '0300\u20091234567', '0300\u202F1234567', '0300\u30001234567', '0300\t1234567', // no-break / thin / narrow no-break / ideographic space, tab
  '\uFF10\uFF13\uFF10\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17', '\uFF0B\uFF19\uFF12 \uFF13\uFF10\uFF10 \uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17', // full-width digits and plus
]) assert.strictEqual(ok('PK', typed).phone, '+923001234567', JSON.stringify(typed));
assert.strictEqual(ok('BD', '\u09E6\u09E7\u09ED\u09E7\u09E8\u09E9\u09EA\u09EB\u09EC\u09ED\u09EE').phone, '+8801712345678', 'Bengali digits');
assert.strictEqual(ok('IN', '\u096F\u096E\u096D\u096C\u096B \u096A\u0969\u0968\u0967\u0966').phone, '+919876543210', 'Devanagari digits');
assert.strictEqual(ok('TH', '\u0E50\u0E58\u0E52 \u0E52\u0E53\u0E54 \u0E55\u0E56\u0E57\u0E58').phone, '+66822345678', 'Thai digits');
// junk in a native script is still junk (a typo, not a different number), and invisible-only input is "nothing typed"
bad('PK', arabic.slice(0, 5), 'phone');
assert.match(bad('PK', '\u200E\u200F\u202A\u202C', 'phone').message, /enter your phone number/);
assert.match(bad('PK', 'x'.repeat(100000), 'phone').message, /too long/, 'a huge input is refused without being processed');
// ...really without being processed: the tidying (String.prototype.normalize) is never run on it, and still runs on a normal number
{
  const realNormalize = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function counted(...args) { calls += 1; return realNormalize.apply(this, args); };
  try {
    normalizePhone({ phoneCountry: 'PK', phone: '9'.repeat(5000000) });
    assert.strictEqual(calls, 0, 'a 5 MB "number" is turned away before any work is done on it');
    normalizePhone({ phoneCountry: 'PK', phone: '0300 1234567' });
    assert.ok(calls > 0, 'a normal number is tidied');
  } finally { String.prototype.normalize = realNormalize; }
}

// ---------- missing / wrong types: never throws ----------
bad('PK', '', 'phone'); bad('PK', '   ', 'phone'); bad('PK', undefined, 'phone'); bad('PK', null, 'phone'); bad('PK', 12345, 'phone'); bad('PK', ['0300 1234567'], 'phone'); bad('PK', { toString: () => '0300 1234567' }, 'phone');
for (const country of [undefined, null, '', ' ', 'XX', 'ZZ', 'PAK', 'P', 12, ['PK'], { a: 1 }, 'AC1']) bad(country, '0300 1234567', 'phoneCountry');
assert.strictEqual(normalizePhone().ok, false);
assert.strictEqual(normalizePhone(undefined).field, 'phoneCountry');

// ---------- stored form is stable and safe to store ----------
const stored = ok('PK', '0300 1234567');
assert.ok(/^\+\d{8,15}$/.test(stored.phone), 'E.164: a plus and 8-15 digits');
assert.ok(/^[A-Z]{2}$/.test(stored.phoneCountry));
assert.strictEqual(countryName('PK'), 'Pakistan');
assert.strictEqual(countryName('ZZ'), 'Unknown Region', 'an unknown code never throws');

console.log('phone service tests passed');
