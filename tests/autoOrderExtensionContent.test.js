// The Auto Order extension's Amazon page reading (auto-order-extension/amazon-content.js), run against a tiny fake
// page - the same technique as tests/extensionVariants.test.js for the existing import extension: the real functions
// are cut out of the real file and run as-is, nothing here re-implements Amazon-reading logic of its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'auto-order-extension', 'amazon-content.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'markers: ' + from); return src.slice(a, b); };
const code = between('  const SELECTORS = {', '  // ---------------------------------------------------------------- the actual flow');

// ---- a tiny fake page ----
function fakeEl(props = {}) {
  return Object.assign({
    textContent: '', disabled: false, children: [], options: [], attrs: {},
    getAttribute(n) { return this.attrs[n] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    click() { this.clicked = true; },
    dispatchEvent() {},
  }, props);
}
function fakeDocument({ query = {}, queryAll = {}, bodyText = '' } = {}) {
  return { body: { innerText: bodyText }, querySelector: (sel) => query[sel] || null, querySelectorAll: (sel) => queryAll[sel] || [] };
}

function run(code, ctx) {
  const context = vm.createContext({ console, JSON, Math, Date, Promise, Object, Array, String, Number, RegExp, Set, Map, Error, Event: function Event(t) { this.type = t; }, ...ctx });
  vm.runInContext(code + '\nthis.__out = { pageKind, readStock, readFulfilledByAmazon, findVariantOption, setQuantity, readCheckoutTotal, addressMatches, readConfirmationOrderId, findGiftOption };', context);
  return context.__out;
}

const ADD_TO_CART = '#add-to-cart-button, input#add-to-cart-button';
const BUY_NOW = '#buy-now-button, input#buy-now-button';
const MERCHANT = '#merchant-info, #tabular-buybox, #buybox';
const PLACE_ORDER = '#submitOrderButtonId, input[name="place-your-order-button"], #placeYourOrder, button[name="placeYourOrder"]';
const QTY_SELECT = '#quantity, select[name="quantity"]';

(async () => {
  // ---------- pageKind(): each state, most specific first ----------
  let fns = run(code, { location: { pathname: '/errors/validateCaptcha', href: 'x' }, document: fakeDocument({ bodyText: 'Enter the characters you see below' }) });
  assert.strictEqual(fns.pageKind(), 'captcha');

  fns = run(code, { location: { pathname: '/ap/signin', href: 'x' }, document: fakeDocument() });
  assert.strictEqual(fns.pageKind(), 'signin');

  fns = run(code, { location: { pathname: '/ap/mfa', href: 'x' }, document: fakeDocument() });
  assert.strictEqual(fns.pageKind(), 'twofactor');

  fns = run(code, { location: { pathname: '/gp/buy/thankyou', href: 'x' }, document: fakeDocument({ bodyText: 'Thanks, your order has been placed.' }) });
  assert.strictEqual(fns.pageKind(), 'confirmation');

  fns = run(code, { location: { pathname: '/gp/buy/spc', href: 'x' }, document: fakeDocument({ query: { [PLACE_ORDER]: fakeEl() } }) });
  assert.strictEqual(fns.pageKind(), 'checkout');

  fns = run(code, { location: { pathname: '/gp/cart/view', href: 'x' }, document: fakeDocument() });
  assert.strictEqual(fns.pageKind(), 'cart');

  fns = run(code, { location: { pathname: '/dp/B0TEST0001', href: 'x' }, document: fakeDocument() });
  assert.strictEqual(fns.pageKind(), 'product');

  fns = run(code, { location: { pathname: '/something/else', href: 'x' }, document: fakeDocument() });
  assert.strictEqual(fns.pageKind(), 'unknown');

  // ---------- readStock(): an enabled buy button means in stock; "Currently unavailable" with no button means not ----------
  fns = run(code, { location: { pathname: '/dp/B0TEST0001' }, document: fakeDocument({ query: { [ADD_TO_CART]: fakeEl({ disabled: false }) } }) });
  assert.strictEqual(fns.readStock(), true);

  fns = run(code, { location: { pathname: '/dp/B0TEST0001' }, document: fakeDocument({ bodyText: 'Currently unavailable.\nWe don\'t know when or if this item will be back in stock.' }) });
  assert.strictEqual(fns.readStock(), false);

  // ---------- readFulfilledByAmazon(): needs BOTH "Sold by Amazon" and "Ships from Amazon" ----------
  fns = run(code, { location: {}, document: fakeDocument({ query: { [MERCHANT]: fakeEl({ textContent: 'Ships from Amazon.com Sold by Amazon.com' }) } }) });
  assert.strictEqual(fns.readFulfilledByAmazon(), true);

  fns = run(code, { location: {}, document: fakeDocument({ query: { [MERCHANT]: fakeEl({ textContent: 'Ships from Amazon.com Sold by Acme Traders' }) } }) });
  assert.strictEqual(fns.readFulfilledByAmazon(), false, 'a third-party seller, even if Amazon ships it');

  // ---------- findVariantOption(): a case-insensitive substring match on title or text, never a guess when ambiguous ----------
  const swatches = [fakeEl({ attrs: { title: 'Click to select Colour: Black' } }), fakeEl({ textContent: 'Blue' })];
  fns = run(code, { location: {}, document: fakeDocument({ queryAll: { '#variation_color_name li, #variation_size_name li, #variation_style_name li, [id^="variation_"] li, [data-a-button-group] li': swatches } }) });
  assert.strictEqual(fns.findVariantOption('black'), swatches[0]);
  assert.strictEqual(fns.findVariantOption('Blue'), swatches[1]);
  assert.strictEqual(fns.findVariantOption('purple'), null);
  assert.strictEqual(fns.findVariantOption(null), null, 'no variant requested: nothing to find');

  // ---------- setQuantity(): only when a matching <option> exists; left alone for 1 or less ----------
  const select = fakeEl({ value: '1', options: [{ value: '1' }, { value: '2' }, { value: '3' }] });
  fns = run(code, { location: {}, document: fakeDocument({ query: { [QTY_SELECT]: select } }) });
  fns.setQuantity(3);
  assert.strictEqual(select.value, '3');
  const untouched = fakeEl({ value: '1', options: [{ value: '1' }, { value: '2' }] });
  fns = run(code, { location: {}, document: fakeDocument({ query: { [QTY_SELECT]: untouched } }) });
  fns.setQuantity(1);
  assert.strictEqual(untouched.value, '1', 'quantity 1 is the default: never touched');

  // ---------- readCheckoutTotal(): the labelled row is preferred; a generic scan is the fallback ----------
  const totalLabel = fakeEl({ textContent: 'Order total:', children: [] });
  const totalRow = fakeEl({ textContent: 'Order total: $23.45' });
  totalLabel.closest = (sel) => (sel === 'tr, li, div' ? totalRow : null);
  fns = run(code, { location: {}, document: fakeDocument({ queryAll: { '*': [totalLabel] }, bodyText: 'Order total: $23.45' } ) });
  assert.strictEqual(fns.readCheckoutTotal(), 23.45);

  fns = run(code, { location: {}, document: fakeDocument({ queryAll: { '*': [] }, bodyText: 'Item: $9.99\nShipping: $0.00\nOrder total: $9.99' }) });
  assert.strictEqual(fns.readCheckoutTotal(), 9.99, 'fallback: the largest amount on the page');

  fns = run(code, { location: {}, document: fakeDocument({ queryAll: { '*': [] }, bodyText: 'No prices here' }) });
  assert.strictEqual(fns.readCheckoutTotal(), null);

  // ---------- addressMatches(): the buyer's postal code must actually appear on the page ----------
  fns = run(code, { location: {}, document: fakeDocument({ bodyText: 'Deliver to Jane Doe, 221B Baker Street, London, NW1 6XE' }) });
  assert.strictEqual(fns.addressMatches({ postalCode: 'NW1 6XE' }), true);
  assert.strictEqual(fns.addressMatches({ postalCode: '90210' }), false);
  assert.strictEqual(fns.addressMatches(null), false);
  assert.strictEqual(fns.addressMatches({}), false, 'no postal code to check: never assumed to match');

  // ---------- findGiftOption(): present on some checkouts, absent on others - never an error either way ----------
  const GIFT = '#gift-options-checkbox, input[name="gift-option"], input[id*="gift-option" i]';
  const giftBox = fakeEl({ attrs: { type: 'checkbox' } });
  fns = run(code, { location: {}, document: fakeDocument({ query: { [GIFT]: giftBox } }) });
  assert.strictEqual(fns.findGiftOption(), giftBox);
  fns = run(code, { location: {}, document: fakeDocument() });
  assert.strictEqual(fns.findGiftOption(), null);

  // ---------- readConfirmationOrderId(): Amazon's own order-number shape ----------
  fns = run(code, { location: {}, document: fakeDocument({ bodyText: 'Your order has been placed.\nOrder# 112-5551234-1234567' }) });
  assert.strictEqual(fns.readConfirmationOrderId(), '112-5551234-1234567');
  fns = run(code, { location: {}, document: fakeDocument({ bodyText: 'No order number here' }) });
  assert.strictEqual(fns.readConfirmationOrderId(), null);

  console.log('auto-order extension content tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
