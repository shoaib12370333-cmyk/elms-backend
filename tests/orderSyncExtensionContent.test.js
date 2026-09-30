// order-sync-extension/content.js's pure page-reading functions (isOrderConfirmationPage, readCheckoutTotal,
// readDeliveryDate), cut out of the real file and run as-is against a tiny fake page - same technique as
// tests/extensionVariants.test.js. Nothing here re-implements Amazon-reading logic of its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'order-sync-extension', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'markers: ' + from); return src.slice(a, b); };
const code = between('  const money =', '  async function main()');

function fakeEl(props = {}) {
  return Object.assign({ textContent: '', children: [], parentElement: null, closest() { return null; } }, props);
}
function fakeDocument({ queryAll = {}, bodyText = '' } = {}) {
  return { body: { innerText: bodyText }, querySelectorAll: (sel) => queryAll[sel] || [] };
}
function run(ctx) {
  const context = vm.createContext({ console, JSON, Math, Date, RegExp, Array, String, Number, Object, ...ctx });
  vm.runInContext(code + '\nthis.__out = { isOrderConfirmationPage, readCheckoutTotal, readDeliveryDate, fullAddressText, addressRowHtml };', context);
  return context.__out;
}

(async () => {
  // ---------- isOrderConfirmationPage(): by path, and by the page's own wording when the path is unfamiliar ----------
  let fns = run({ location: { pathname: '/gp/buy/thankyou' }, document: fakeDocument() });
  assert.strictEqual(fns.isOrderConfirmationPage(), true);
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument() });
  assert.strictEqual(fns.isOrderConfirmationPage(), true);
  fns = run({ location: { pathname: '/gp/css/order-history' }, document: fakeDocument({ bodyText: 'Thanks, your order has been placed.' }) });
  assert.strictEqual(fns.isOrderConfirmationPage(), true, 'an unfamiliar path but the page itself says so');
  fns = run({ location: { pathname: '/dp/B0TEST0001' }, document: fakeDocument({ bodyText: 'Buy it now' }) });
  assert.strictEqual(fns.isOrderConfirmationPage(), false, 'an ordinary product page');

  // ---------- readCheckoutTotal(): the labelled "Order total" line wins over any other amount on the page ----------
  const totalLabel = fakeEl({ textContent: 'Order Total:', children: [] });
  const totalRow = fakeEl({ textContent: 'Order Total: $45.99' }); // its own small row/container - never the whole page's text
  totalLabel.closest = () => totalRow;
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ queryAll: { '*': [totalLabel] }, bodyText: 'Items: $12.00 Shipping: $3.99 Order Total: $45.99' }) });
  assert.strictEqual(fns.readCheckoutTotal(), 45.99, 'the labelled row\'s own total, not the first dollar amount anywhere on the page');

  // ---------- readCheckoutTotal(): no labelled element found - falls back to the largest amount on the page ----------
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Item price $12.00, shipping $3.99, grand total shown as $15.99 somewhere unlabelled' }) });
  assert.strictEqual(fns.readCheckoutTotal(), 15.99);

  // ---------- readCheckoutTotal(): nothing that looks like money anywhere - never guesses, returns null ----------
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Your order is confirmed.' }) });
  assert.strictEqual(fns.readCheckoutTotal(), null);

  // ---------- readDeliveryDate(): "Arriving <weekday>, <month> <day>" and "Estimated delivery: <month> <day>, <year>" ----------
  // Built as a plain string from the parsed parts (never through `new Date(...).toISOString()`, which can shift the
  // day depending on the machine's own timezone), so the expected values here are literal strings too.
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Arriving Tuesday, Oct 7' }) });
  assert.strictEqual(fns.readDeliveryDate(), `${new Date().getFullYear()}-10-07`, 'no year on the page: assumes the current year');
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Estimated delivery: October 12, 2026' }) });
  assert.strictEqual(fns.readDeliveryDate(), '2026-10-12');
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Estimated delivery: Dec 3, 2026' }) });
  assert.strictEqual(fns.readDeliveryDate(), '2026-12-03', 'a 3-letter month abbreviation and a single-digit day, both zero-padded');
  fns = run({ location: { pathname: '/spc/confirmation' }, document: fakeDocument({ bodyText: 'Thanks for your order.' }) });
  assert.strictEqual(fns.readDeliveryDate(), null, 'no delivery wording on the page - never guessed');

  // ---------- fullAddressText(): a clean, shipping-label-style block - never a stray blank line for a missing field ----------
  fns = run({ location: { pathname: '/dp/x' }, document: fakeDocument() });
  assert.strictEqual(
    fns.fullAddressText({ fullName: 'Jane Doe', addressLine1: '221B Baker St', addressLine2: '', city: 'London', stateOrProvince: '', postalCode: 'NW1 6XE', country: 'United Kingdom' }),
    'Jane Doe\n221B Baker St\nLondon, NW1 6XE\nUnited Kingdom',
    'no address line 2 or state: no blank line or stray comma left behind'
  );
  assert.strictEqual(
    fns.fullAddressText({ fullName: 'Sam Lee', addressLine1: '1 Main St', addressLine2: 'Apt 4', city: 'Austin', stateOrProvince: 'TX', postalCode: '73301', country: 'United States' }),
    'Sam Lee\n1 Main St\nApt 4\nAustin, TX, 73301\nUnited States'
  );

  // ---------- addressRowHtml(): never emitted for a field the order has no value for; user-typed text is escaped ----------
  fns = run({ location: { pathname: '/dp/x' }, document: fakeDocument() });
  assert.strictEqual(fns.addressRowHtml('Address line 2', ''), '', 'blank field: no row at all, not an empty one');
  assert.strictEqual(fns.addressRowHtml('Address line 2', null), '');
  const row = fns.addressRowHtml('Name', '<b>Jane</b> & "Sons"');
  assert.ok(!row.includes('<b>Jane</b>'), 'the buyer\'s own text is escaped, never rendered as HTML');
  assert.ok(row.includes('&lt;b&gt;Jane&lt;/b&gt;'));
  assert.ok(row.includes('data-copy="&lt;b&gt;Jane&lt;/b&gt; &amp; &quot;Sons&quot;"'), 'the un-escaped value is still what gets copied to the clipboard');

  console.log('order sync extension content tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
