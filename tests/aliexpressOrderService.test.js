// services/aliexpressOrderService.js: buying an eBay order's item from AliExpress. Real money moves here, so this checks the safety
// rules one by one: the preview's blockers (and that AliExpress is not even asked when an order may not be placed), that two clicks can
// never place the same order twice, that "AliExpress refused" (retry is safe) is never confused with "no clear answer" (an order MAY
// exist), that nothing is paid unless the seller confirmed exactly the amount AliExpress asks for, and that the read-back saves
// status / total / tracking without ever touching eBay. The real service runs; the models and AliExpress are in-memory stand-ins.
const assert = require('assert');
const S = require('../services/aliexpressOrderService');

const OID = '64f0c1e2a3b4c5d6e7f80912';
const realLog = console.log;
const serviceLogs = [];
console.log = (...args) => { if (String(args[0]).startsWith('[aliexpress-order]')) serviceLogs.push(String(args[0])); else realLog(...args); }; // the service logs every placed / paid order
const camelToSnake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

// ---------------- in-memory world ----------------
let orders; let listings; let calls; let adapterBehaviour; let paidFlag; let updateFailures;
const loggedWhenPlacedSaved = [];
// What AliExpress shows for an order that is waiting for payment and has ONE line: the product, option and quantity ELMS ordered.
const baseDetail = (over = {}) => ({ status: 'PLACE_ORDER_SUCCESS', logisticsStatus: null, amount: 12.5, currency: 'USD', paidAt: null, logistics: [], lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: null }], ...over });
// Once a payment was ACCEPTED, AliExpress shows it (a payment time and a status that can only follow paying).
const showPaid = (d) => (paidFlag ? { ...d, paidAt: '2026-10-03T10:00:00-07:00', status: 'WAIT_SELLER_SEND_GOODS' } : d);
const payAccepted = async () => { paidFlag = true; return { paid: true, message: null }; };
const reset = () => {
  paidFlag = false; updateFailures = 0;
  calls = { product: [], quote: [], create: [], pay: [], detail: [], tracking: [], claim: [], claimPay: [], releasePay: [], update: [], guards: [], convert: [] };
  orders = new Map([[OID, order()]]);
  listings = new Map([['L1', { id: 'L1', source_platform: 'aliexpress', aliexpress_product_id: 'P1', aliexpress_sku_id: 'S1', currency: 'USD', title: 'Widget' }]]);
  adapterBehaviour = {
    product: async () => productDetail(),
    quote: async () => ({ ...QUOTE }),
    create: async () => ({ orderIds: ['5001'] }),
    pay: payAccepted,
    detail: async () => showPaid(baseDetail()),
    tracking: async () => [],
    convert: async (amount, from, to) => ({ amount: Number((amount * (from === to ? 1 : 0.8)).toFixed(2)) }),
  };
};
function order(over = {}) {
  return {
    id: OID, listing_id: 'L1', quantity: 2, sale_price: 40, delivery_cost: 3, currency: 'GBP', fulfillment_status: 'pending', order_status: 'awaiting_shipment', ordered_at: null, amazon_order_id: null,
    ebay_payment_status: 'PAID', ebay_cancel_status: 'NONE_REQUESTED', buyer_phone: '07700 900123',
    shipping_address: { fullName: 'Jo Smith', addressLine1: '1 High St', addressLine2: null, city: 'Leeds', stateOrProvince: 'West Yorkshire', postalCode: 'LS1 1AA', country: 'GB' },
    aliexpress_order: null, ...over,
  };
}
const QUOTE = { cost: 2.5, currency: 'USD', free: false, carrier: 'AliExpress Standard Shipping', code: 'CAINIAO_FULFILLMENT_STD', minDays: 7, maxDays: 15, shipFrom: 'CN', tracking: true };
const productDetail = (skuOver = {}) => ({
  ae_item_base_info_dto: { subject: 'Widget from AliExpress' },
  ae_item_sku_info_dtos: [{ sku_id: 'S1', sku_attr: '73:175#Black;71:193#Big', offer_sale_price: '5.00', sku_available_stock: '10', currency_code: 'USD', ...skuOver }],
});

const deps = {
  getOrder: async (u, id) => { const o = orders.get(id); return o ? JSON.parse(JSON.stringify(o)) : null; },
  getListing: async (u, id) => listings.get(id) || null,
  claim: async (u, id, opts) => {
    calls.claim.push({ id, opts });
    const o = orders.get(id); if (!o) return null;
    const state = o.aliexpress_order && o.aliexpress_order.state;
    const claimable = [undefined, null, 'failed', ...(opts && opts.retryUnknown ? ['unknown'] : [])];
    if (!claimable.includes(state)) return null;
    o.aliexpress_order = { ...(o.aliexpress_order || {}), state: 'placing', error: null, error_code: null };
    return JSON.parse(JSON.stringify(o));
  },
  update: async (u, id, patch, guard) => {
    calls.update.push(patch);
    calls.guards.push(guard || null);
    if (updateFailures > 0) { updateFailures -= 1; throw new Error('database hiccup'); }
    if (patch.state === 'placed') loggedWhenPlacedSaved.push(serviceLogs.slice());
    const o = orders.get(id); if (!o) return null;
    const cur = o.aliexpress_order || {};
    // the same conditions as models/ordersModel.js updateAliexpressOrder: a write whose guard no longer holds changes nothing
    if (guard && guard.state !== undefined && cur.state !== guard.state) return null;
    if (guard && guard.aeOrderId !== undefined && String(cur.ae_order_id) !== String(guard.aeOrderId)) return null;
    if (guard && Array.isArray(guard.payStateNotIn) && guard.payStateNotIn.includes(cur.pay_state)) return null;
    o.aliexpress_order = { ...(o.aliexpress_order || {}) };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) o.aliexpress_order[camelToSnake(k)] = v;
    return JSON.parse(JSON.stringify(o));
  },
  claimPayment: async (u, id) => {
    calls.claimPay.push(id);
    const o = orders.get(id); if (!o) return null;
    const ae = o.aliexpress_order;
    const stale = ae && ae.pay_state === 'paying' && ae.paying_at && deps.now().getTime() - new Date(ae.paying_at).getTime() > 5 * 60 * 1000;
    if (!ae || ae.state !== 'placed' || !(!ae.pay_state || ae.pay_state === 'unpaid' || stale)) return null;
    o.aliexpress_order = { ...ae, pay_state: 'paying', paying_at: deps.now() };
    return JSON.parse(JSON.stringify(o));
  },
  releasePayment: async (u, id) => {
    calls.releasePay.push(id);
    const o = orders.get(id); if (!o || !o.aliexpress_order || o.aliexpress_order.pay_state !== 'paying') return null;
    o.aliexpress_order = { ...o.aliexpress_order, pay_state: 'unpaid' };
    return JSON.parse(JSON.stringify(o));
  },
  adapter: () => ({
    getProductDetail: async (u, a) => { calls.product.push(a); return adapterBehaviour.product(a); },
    quoteShipping: async (u, a) => { calls.quote.push(a); return adapterBehaviour.quote(a); },
    createOrder: async (u, a) => { calls.create.push(a); return adapterBehaviour.create(a); },
    payOrder: async (u, id) => { calls.pay.push(id); return adapterBehaviour.pay(id); },
    getOrderDetail: async (u, id) => { calls.detail.push(id); return adapterBehaviour.detail(id); },
    getOrderTracking: async (u, id) => { calls.tracking.push(id); return adapterBehaviour.tracking(id); },
  }),
  convert: async (a, f, t) => { calls.convert.push([a, f, t]); return adapterBehaviour.convert(a, f, t); },
  now: () => new Date('2026-10-03T12:00:00Z'),
  sleep: async () => {},
};
const codes = (r) => r.blockers.map((b) => b.code);
const noAliexpressCalls = () => calls.product.length + calls.quote.length + calls.create.length + calls.pay.length + calls.detail.length === 0;

(async () => {
  // =====================================================================================================================
  // pure helpers
  // =====================================================================================================================
  assert.deepStrictEqual(S.splitPhone('+44 7700 900123', 'GB'), { phoneCountry: '+44', mobileNo: '7700900123' });
  assert.deepStrictEqual(S.splitPhone('07700 900123', 'GB'), { phoneCountry: '+44', mobileNo: '7700900123' }, 'a national number takes the destination country\'s code and loses its trunk 0');
  assert.deepStrictEqual(S.splitPhone('0044 20 7946 0958', 'US'), { phoneCountry: '+44', mobileNo: '2079460958' }, '00 = +, and the number\'s own code wins over the destination country');
  assert.deepStrictEqual(S.splitPhone('(415) 555-2671', 'US'), { phoneCountry: '+1', mobileNo: '4155552671' });
  assert.deepStrictEqual(S.splitPhone('+353 87 123 4567', 'IE'), { phoneCountry: '+353', mobileNo: '871234567' }, 'the longest dial code wins');
  assert.deepStrictEqual(S.splitPhone('12345', 'ZZ'), { phoneCountry: null, mobileNo: '12345' });
  assert.deepStrictEqual(S.splitPhone('', 'US').mobileNo, '');
  assert.deepStrictEqual(S.splitPhone('+44 (0)7700 900123', 'GB'), { phoneCountry: '+44', mobileNo: '7700900123' }, 'the "(0)" trunk digit people write is not dialled from abroad');
  assert.deepStrictEqual(S.splitPhone('07700 900123 ext. 45', 'GB'), { phoneCountry: '+44', mobileNo: '7700900123' }, 'an extension is not part of the number');
  assert.deepStrictEqual(S.splitPhone('(415) 555-2671 x12', 'US'), { phoneCountry: '+1', mobileNo: '4155552671' });
  assert.deepStrictEqual(S.splitPhone('1 415 555 2671', 'US'), { phoneCountry: '+1', mobileNo: '4155552671' }, 'a US number written with its own 1 is not sent as +1 1...');
  assert.deepStrictEqual(S.splitPhone('447700 900123', 'GB'), { phoneCountry: '+44', mobileNo: '7700900123' }, 'the same for the UK');
  assert.deepStrictEqual(S.splitPhone('4155552671', 'US'), { phoneCountry: '+1', mobileNo: '4155552671' }, 'a 10-digit US number is left alone');
  assert.deepStrictEqual(S.splitPhone('06 1234 5678', 'IT'), { phoneCountry: '+39', mobileNo: '0612345678' }, 'the 0 of an Italian landline is part of the number');
  assert.deepStrictEqual(S.splitPhone('+39 06 1234 5678', 'IT'), { phoneCountry: '+39', mobileNo: '0612345678' });
  assert.deepStrictEqual(S.splitPhone('55 99999 9999', 'BR'), { phoneCountry: '+55', mobileNo: '55999999999' }, '55 is an area code in Brazil, not a second country code');
  assert.deepStrictEqual(S.splitPhone('1 415 555 267', 'US').mobileNo, '1415555267', 'only a full 11-digit US number loses its leading 1');
  assert.deepStrictEqual(S.splitPhone('44770090012', 'GB').mobileNo, '44770090012', 'a UK number shorter than 12 digits is left alone');
  assert.deepStrictEqual(S.splitPhone('+1 415 555 2671 Extension 9', 'US'), { phoneCountry: '+1', mobileNo: '4155552671' });

  // amounts from the browser: only a real number, or text that is only a number
  for (const [v, want] of [[12.5, 12.5], ['12.50', 12.5], [' 7 ', 7], [0, 0], ['0.0', 0]]) assert.strictEqual(S.strictAmount(v), want, String(v));
  for (const v of [null, undefined, '', ' ', [], [5], false, true, {}, 'abc', '1e3', '-5', '12,5', NaN, Infinity, '12.5 USD']) assert.strictEqual(S.strictAmount(v), null, JSON.stringify(v) + ' is not an amount');
  assert.deepStrictEqual(S.OVERRIDE_FLAG, { loses_money: 'allowLoss', sale_unknown: 'allowLoss', currency_unknown: 'allowLoss', unknown_state: 'confirmNotPlaced', already_ordered: 'confirmNotPlaced' });

  const a = S.addressOf(order(), { country: 'gb ', city: '  Leeds   North ', line2: 'Flat 2', phone: null });
  assert.strictEqual(a.country, 'GB', 'upper-cased');
  assert.strictEqual(a.city, 'Leeds North', 'spaces tidied');
  assert.strictEqual(a.line2, 'Flat 2', 'an override wins field by field');
  assert.strictEqual(a.phone, '07700 900123', 'null in an override means "not given": the order\'s own value stays');
  assert.strictEqual(a.fullName, 'Jo Smith');
  assert.strictEqual(S.addressOf(order({ shipping_address: null, buyer_phone: null })).line1, '', 'no address at all: empty fields, no crash');
  assert.deepStrictEqual(S.toLogisticsAddress(a), {
    contact_person: 'Jo Smith', full_name: 'Jo Smith', address: '1 High St', address2: 'Flat 2', city: 'Leeds North', province: 'West Yorkshire',
    zip: 'LS1 1AA', country: 'GB', mobile_no: '7700900123', phone_country: '+44', locale: 'en_US',
  });
  assert.strictEqual(S.toLogisticsAddress({ ...a, state: '', line2: '' }).province, 'Leeds North', 'no state: the city stands in');
  assert.ok(!('address2' in S.toLogisticsAddress({ ...a, line2: '' })));
  assert.match(S.outOrderIdFor(OID), /^\d{1,18}$/, 'numeric, like AliExpress\'s own example');
  assert.strictEqual(S.outOrderIdFor(OID), S.outOrderIdFor(OID), 'stable for the same line');
  assert.notStrictEqual(S.outOrderIdFor(OID), S.outOrderIdFor('64f0c1e2a3b4c5d6e7f80913'));
  assert.strictEqual(S.outOrderIdFor(''), null);

  assert.deepStrictEqual(S.explainError({ rejected: true, aliCode: 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL', message: 'x' }).state, 'failed');
  assert.match(S.explainError({ rejected: true, aliCode: 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL' }).message, /address is wrong/);
  assert.match(S.explainError({ rejected: true, aliCode: 'A003_SUSPICIOUS_BUYER' }).message, /A003_SUSPICIOUS_BUYER.*Contact AliExpress/);
  assert.strictEqual(S.explainError({ rejected: true, aliCode: 'REPEATED_ORDER_ERROR' }).state, 'unknown', 'a duplicate means an order MAY exist: never a safe retry');
  assert.strictEqual(S.explainError({ rejected: false, message: 'empty' }).state, 'unknown');
  assert.strictEqual(S.explainError(new Error('Could not reach AliExpress: timeout')).state, 'unknown', 'no answer at all: unknown');
  assert.strictEqual(S.explainError({ rejected: true, message: 'Because' }).message, 'Because');
  for (const [status, finished] of [['FINISH', true], ['CLOSED', true], ['CANCELED', true], ['WAIT_SELLER_SEND_GOODS', false], ['FUND_PROCESSING', false], [null, false], ['', false]]) assert.strictEqual(S.isFinishedStatus(status), finished, String(status));

  // =====================================================================================================================
  // previewOrder
  // =====================================================================================================================
  reset();
  let pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(pv.blockers, []);
  assert.strictEqual(pv.canPlace, true);
  assert.deepStrictEqual(pv.item, { productId: 'P1', skuId: 'S1', skuAttr: '73:175;71:193', optionNames: 'Black, Big', title: 'Widget from AliExpress', quantity: 2, unitPrice: 5, currency: 'USD', stock: 10 });
  assert.strictEqual(pv.shipping.code, 'CAINIAO_FULFILLMENT_STD');
  assert.deepStrictEqual(pv.cost, { items: 10, shipping: 2.5, total: 12.5, currency: 'USD' });
  assert.deepStrictEqual(pv.sale, { amount: 43, currency: 'GBP' }, 'what the buyer paid for the line: item + delivery');
  assert.deepStrictEqual([pv.margin.amount, pv.margin.currency, pv.margin.costInSaleCurrency], [33, 'GBP', 10], 'the cost is converted to the sale currency before the comparison');
  assert.strictEqual(pv.address.fullName, 'Jo Smith');
  assert.deepStrictEqual(calls.product, [{ productId: 'P1', shipToCountry: 'GB', targetCurrency: 'USD' }]);
  assert.deepStrictEqual(calls.quote, [{ productId: 'P1', skuId: 'S1', shipToCountry: 'GB', currency: 'USD', quantity: 2 }], 'quoted for the order\'s quantity');
  assert.strictEqual(calls.create.length + calls.pay.length, 0, 'a preview never orders or pays');

  assert.deepStrictEqual(await S.previewOrder('u1', 'nope', {}, deps), { error: 'not_found' });

  // an order that may not be placed: the reason is given and AliExpress is NOT asked at all
  for (const [name, over, code] of [
    ['shipped', { fulfillment_status: 'shipped' }, 'shipped'],
    ['delivered', { fulfillment_status: 'delivered' }, 'shipped'],
    ['cancelled', { ebay_cancel_status: 'CANCELED' }, 'cancelled'],
    ['cancel requested', { ebay_cancel_status: 'CANCEL_REQUESTED' }, 'cancelled'],
    ['not paid on eBay', { ebay_payment_status: 'PENDING' }, 'not_paid'],
    ['refunded', { ebay_payment_status: 'FULLY_REFUNDED' }, 'not_paid'],
    ['already placed', { aliexpress_order: { state: 'placed', ae_order_id: '5001' } }, 'already_placed'],
    ['in flight', { aliexpress_order: { state: 'placing' } }, 'in_flight'],
    // order_status is what the seller SEES on eBay - it also knows what eBay itself says (a line eBay shows fulfilled / cancelled, whatever ELMS recorded)
    ['shipped on eBay only', { order_status: 'shipped' }, 'shipped'],
    ['delivered on eBay only', { order_status: 'delivered' }, 'shipped'],
    ['cancelled on eBay only', { order_status: 'cancelled' }, 'cancelled'],
    ['awaiting payment on eBay only', { order_status: 'awaiting_payment', ebay_payment_status: null }, 'not_paid'],
  ]) {
    reset(); orders.set(OID, order(over));
    pv = await S.previewOrder('u1', OID, {}, deps);
    assert.ok(codes(pv).includes(code), name + ': ' + JSON.stringify(codes(pv)));
    assert.strictEqual(pv.canPlace, false, name);
    assert.ok(noAliexpressCalls(), name + ': AliExpress was not asked');
  }
  reset(); orders.set(OID, order({ ebay_payment_status: null })); // an order eBay gave no payment status for: not blocked on that alone
  assert.ok(!codes(await S.previewOrder('u1', OID, {}, deps)).includes('not_paid'));

  // not an AliExpress listing / no listing at all
  reset(); listings.set('L1', { id: 'L1', source_platform: 'amazon', currency: 'USD' });
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(codes(pv), ['not_aliexpress']);
  assert.ok(noAliexpressCalls());
  reset(); orders.set(OID, order({ listing_id: null }));
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['not_aliexpress']);
  reset(); listings.set('L1', { id: 'L1', source_platform: 'aliexpress', aliexpress_product_id: 'P1', aliexpress_sku_id: null, currency: 'USD' });
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['not_aliexpress'], 'an AliExpress listing without its ids cannot be ordered');

  // an earlier try that FAILED (AliExpress refused) is simply tried again; one that was UNKNOWN needs the seller's say-so (overridable)
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'failed', error: 'x' } }));
  assert.strictEqual((await S.previewOrder('u1', OID, {}, deps)).canPlace, true);
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'unknown', error: 'No clear answer.' } }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(pv.blockers.map((b) => [b.code, !!b.overridable, b.override]), [['unknown_state', true, 'confirmNotPlaced']]);
  assert.strictEqual(pv.item.productId, 'P1', 'the rest of the preview is still worked out');

  // already marked as ordered (ELMS' "Mark as ordered", or an order number typed in): placing another may buy it twice -> the seller must confirm
  for (const [name, over] of [['marked ordered', { fulfillment_status: 'ordered_from_amazon' }], ['ordered date', { ordered_at: '2026-10-01T10:00:00Z' }], ['an order number', { amazon_order_id: '123-456' }]]) {
    reset(); orders.set(OID, order(over));
    pv = await S.previewOrder('u1', OID, {}, deps);
    assert.deepStrictEqual(pv.blockers.map((b) => [b.code, !!b.overridable, b.override]), [['already_ordered', true, 'confirmNotPlaced']], name);
    assert.strictEqual(pv.item.productId, 'P1', name + ': the rest of the preview is still worked out');
    assert.strictEqual((await S.placeOrder('u1', OID, {}, deps)).error, 'blocked', name);
    assert.strictEqual((await S.placeOrder('u1', OID, { allowLoss: true }, deps)).error, 'blocked', name + ': the money switch does not excuse it');
    assert.strictEqual(calls.create.length, 0, name);
    assert.ok((await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['already_ordered'] }, deps)).order, name + ': after the seller confirmed');
  }

  // the delivery address: every missing part is named; an edit from the browser fixes it
  reset(); orders.set(OID, order({ shipping_address: { fullName: 'Jo', addressLine1: '1 High St', city: 'Leeds', postalCode: '', country: 'GB' }, buyer_phone: '' }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(codes(pv).sort(), ['address_phone', 'address_zip']);
  pv = await S.previewOrder('u1', OID, { address: { zip: 'LS1 1AA', phone: '+44 7700 900123' } }, deps);
  assert.deepStrictEqual(pv.blockers, [], 'typed in the window -> fine');
  reset(); orders.set(OID, order({ shipping_address: { fullName: 'Jo', addressLine1: '1 High St', city: 'Leeds', postalCode: 'LS1', country: '' } }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(codes(pv), ['address_country']);
  assert.strictEqual(calls.quote.length, 0, 'no country: no shipping quote is asked for');
  // a phone number that cannot be one is caught here, not by AliExpress after the click
  for (const phone of ['123', '+44 1', 'call me', '+44 7700 900 123 456 789 012 34']) {
    reset(); orders.set(OID, order({ buyer_phone: phone }));
    pv = await S.previewOrder('u1', OID, {}, deps);
    assert.ok(codes(pv).includes('address_phone'), phone);
  }
  reset(); orders.set(OID, order({ buyer_phone: '+44 (0)7700 900123 ext 5' }));
  assert.deepStrictEqual((await S.previewOrder('u1', OID, {}, deps)).blockers, [], 'a normal number with a trunk 0 and an extension is fine');

  // the product at AliExpress
  reset(); adapterBehaviour.product = async () => productDetail({ sku_available_stock: '1' });
  assert.ok(codes(await S.previewOrder('u1', OID, {}, deps)).includes('out_of_stock'), '1 in stock, 2 needed');
  reset(); adapterBehaviour.product = async () => productDetail({ sku_available_stock: '2' });
  assert.deepStrictEqual((await S.previewOrder('u1', OID, {}, deps)).blockers, [], 'exactly enough');
  reset(); adapterBehaviour.product = async () => { const d = productDetail(); delete d.ae_item_sku_info_dtos[0].sku_available_stock; return d; };
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual([pv.blockers.length, pv.warnings.map((w) => w.code)], [0, ['stock_unknown']], 'no stock figure: a warning, not a block');
  reset(); adapterBehaviour.product = async () => productDetail({ sku_id: 'OTHER' });
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['sku_missing']);
  reset(); adapterBehaviour.product = async () => { const d = productDetail(); d.ae_item_sku_info_dtos.push({ ...d.ae_item_sku_info_dtos[0] }); return d; };
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['sku_missing'], 'two options with the same number: never guess which');
  // the option string: every part must be sendable, or AliExpress would fill in some OTHER option (the buyer gets the wrong item)
  for (const [name, skuOver, extraSkus] of [
    ['a part that is not property:value', { sku_attr: '14:771#white;5:custom text' }, 0],
    ['a text-only option', { sku_attr: 'Red / Large' }, 0],
    ['two options of the product but no option string', { sku_attr: '' }, 1],
    ['option properties listed but no option string', { sku_attr: undefined, ae_sku_property_dtos: [{ sku_property_id: 14 }] }, 0],
  ]) {
    reset(); adapterBehaviour.product = async () => { const d = productDetail(skuOver); for (let i = 0; i < extraSkus; i += 1) d.ae_item_sku_info_dtos.push({ sku_id: 'S9' + i, sku_attr: '14:1', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
    pv = await S.previewOrder('u1', OID, {}, deps);
    assert.deepStrictEqual(pv.blockers.map((b) => [b.code, !!b.overridable]), [['sku_attr_unclear', false]], name + ': never overridable');
    assert.strictEqual((await S.placeOrder('u1', OID, { allowLoss: true, confirmNotPlaced: true }, deps)).error, 'blocked', name);
    assert.strictEqual(calls.create.length, 0, name);
  }
  // clear cases: a product with ONE option-less sku, names after "#", the API's own plain example
  for (const sku_attr of ['', '14:70221', '73:175#Black Green;71:193#Polarized']) {
    reset(); adapterBehaviour.product = async () => productDetail({ sku_attr });
    assert.deepStrictEqual((await S.previewOrder('u1', OID, {}, deps)).blockers, [], JSON.stringify(sku_attr));
  }
  // 17-digit sku ids saved BEFORE ids were read exactly may have been rounded (…203 -> …204): if another option's real id rounds to the saved
  // id, the saved id could mean either - never guess; and a plain exact match with no twin is fine
  reset(); listings.set('L1', { ...listings.get('L1'), aliexpress_sku_id: '12000027158136204' });
  adapterBehaviour.product = async () => { const d = productDetail({ sku_id: '12000027158136204', sku_attr: '14:1' }); d.ae_item_sku_info_dtos.push({ sku_id: '12000027158136203', sku_attr: '14:2', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(codes(pv), ['sku_missing'], 'an exact match, but a sibling rounds to the same saved id');
  assert.match(pv.blockers[0].message, /rounded.*import the product again/i);
  assert.strictEqual(pv.item, null, 'no item is worked out for an ambiguous option');
  reset(); listings.set('L1', { ...listings.get('L1'), aliexpress_sku_id: '12000027158136204' });
  adapterBehaviour.product = async () => productDetail({ sku_id: '12000027158136203', sku_attr: '14:1' }); // only the odd id exists: the saved one was rounded
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['sku_missing']);
  reset(); listings.set('L1', { ...listings.get('L1'), aliexpress_sku_id: '12000027158136204' });
  adapterBehaviour.product = async () => { const d = productDetail({ sku_id: '12000027158136204', sku_attr: '14:1' }); d.ae_item_sku_info_dtos.push({ sku_id: '12000027158136300', sku_attr: '14:2', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
  assert.deepStrictEqual((await S.previewOrder('u1', OID, {}, deps)).blockers, [], 'siblings that do not round to it do not matter');
  // ...but a listing imported AFTER ids were read exactly says so (aliexpress_ids_exact) and is trusted: consecutive sku ids are common, and
  // 200 / 201 are two different, exactly-read options (Number('...201') rounds to ...200, which must not block an exact listing forever)
  reset(); listings.set('L1', { ...listings.get('L1'), aliexpress_sku_id: '12000027158136200', aliexpress_ids_exact: true });
  adapterBehaviour.product = async () => { const d = productDetail({ sku_id: '12000027158136200', sku_attr: '14:1' }); d.ae_item_sku_info_dtos.push({ sku_id: '12000027158136201', sku_attr: '14:2', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
  assert.deepStrictEqual((await S.previewOrder('u1', OID, {}, deps)).blockers, [], 'an exactly-read id with a consecutive sibling is fine');
  reset(); listings.set('L1', { ...listings.get('L1'), aliexpress_sku_id: '12000027158136200', aliexpress_ids_exact: false });
  adapterBehaviour.product = async () => { const d = productDetail({ sku_id: '12000027158136200', sku_attr: '14:1' }); d.ae_item_sku_info_dtos.push({ sku_id: '12000027158136201', sku_attr: '14:2', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['sku_missing'], 'an older import cannot be told apart from a rounded one');
  // two options that would be sent as the SAME option string cannot be told apart
  reset(); adapterBehaviour.product = async () => { const d = productDetail({ sku_attr: '14:1#Red' }); d.ae_item_sku_info_dtos.push({ sku_id: 'S2', sku_attr: '14:1#Crimson', offer_sale_price: '5', sku_available_stock: '3', currency_code: 'USD' }); return d; };
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['sku_attr_unclear']);
  // the option's names are shown to the seller
  reset(); adapterBehaviour.product = async () => productDetail({ sku_attr: '14:1#Red;5:2#Large' });
  assert.strictEqual((await S.previewOrder('u1', OID, {}, deps)).item.optionNames, 'Red, Large');
  // the sale currency is not guessed from the cost currency
  reset(); orders.set(OID, order({ currency: null }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(pv.blockers.map((b) => [b.code, b.override]), [['currency_unknown', 'allowLoss']]);
  assert.strictEqual(pv.sale.currency, null);
  assert.strictEqual(calls.convert.length, 0, 'nothing was converted on a guess');
  reset(); adapterBehaviour.product = async () => productDetail({ offer_sale_price: undefined, sku_price: undefined });
  assert.ok(codes(await S.previewOrder('u1', OID, {}, deps)).includes('no_price'));
  reset(); adapterBehaviour.product = async () => { throw Object.assign(new Error('AliExpress does not have that product.'), { productMissing: true }); };
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['product_gone']);
  reset(); adapterBehaviour.product = async () => { throw new Error('AliExpress is not connected for this account.'); };
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(codes(pv), ['aliexpress_error']);
  assert.match(pv.blockers[0].message, /not connected/);

  // delivery
  reset(); adapterBehaviour.quote = async () => null;
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['no_shipping']);
  reset(); adapterBehaviour.quote = async () => ({ ...QUOTE, code: null });
  assert.deepStrictEqual(codes(await S.previewOrder('u1', OID, {}, deps)), ['no_shipping'], 'logistics_service_name is required: an option without a name cannot be ordered');

  // money: an order that would lose money is blocked (overridable); a thin one only warns
  reset(); orders.set(OID, order({ sale_price: 5, delivery_cost: 0 }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(pv.blockers.map((b) => [b.code, !!b.overridable]), [['loses_money', true]]);
  assert.match(pv.blockers[0].message, /cost 10\.00 GBP.*paid 5\.00 GBP.*loss of 5\.00/);
  assert.strictEqual(pv.margin.amount, -5);
  reset(); orders.set(OID, order({ sale_price: 11.5, delivery_cost: 0 })); // cost 10 -> 1.5 left = 13% of the sale
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual([pv.blockers.length, pv.warnings.map((w) => w.code)], [0, ['thin_margin']]);
  reset(); orders.set(OID, order({ sale_price: 10, delivery_cost: 0 })); // exactly break-even: not a loss
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.ok(!codes(pv).includes('loses_money'));
  reset(); orders.set(OID, order({ sale_price: null, delivery_cost: null }));
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual([pv.blockers.map((b) => [b.code, b.override]), pv.margin], [[['sale_unknown', 'allowLoss']], null], 'no sale figure: it cannot be judged - the seller must accept that on purpose');
  assert.strictEqual(pv.canPlace, false);
  assert.strictEqual((await S.placeOrder('u1', OID, {}, deps)).error, 'blocked');
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: true }, deps)).error, 'blocked', 'the other switch does not accept it');
  assert.ok((await S.placeOrder('u1', OID, { allowLoss: true, shownCodes: ['sale_unknown'] }, deps)).order, 'accepted with allowLoss');
  reset(); adapterBehaviour.convert = async () => { throw new Error('No exchange rate'); };
  pv = await S.previewOrder('u1', OID, {}, deps);
  assert.deepStrictEqual([pv.blockers.map((b) => [b.code, b.override]), pv.margin], [[['currency_unknown', 'allowLoss']], null], 'no exchange rate: blocked, not a made-up comparison');
  assert.strictEqual((await S.placeOrder('u1', OID, {}, deps)).error, 'blocked');
  assert.ok((await S.placeOrder('u1', OID, { allowLoss: true, shownCodes: ['currency_unknown'] }, deps)).order, 'accepted with allowLoss');
  reset(); orders.set(OID, order({ currency: 'USD', sale_price: 30, delivery_cost: 0 }));
  await S.previewOrder('u1', OID, {}, deps);
  assert.strictEqual(calls.convert.length, 0, 'same currency: nothing to convert');

  // =====================================================================================================================
  // placeOrder
  // =====================================================================================================================
  reset();
  let out = await S.placeOrder('u1', OID, {}, deps);
  assert.ok(out.order, JSON.stringify(out));
  assert.strictEqual(calls.create.length, 1);
  assert.deepStrictEqual(calls.create[0], {
    items: [{ productId: 'P1', skuAttr: '73:175;71:193', quantity: 2, logisticsServiceName: 'CAINIAO_FULFILLMENT_STD' }],
    address: S.toLogisticsAddress(S.addressOf(order())),
    outOrderId: S.outOrderIdFor(OID),
    payCurrency: 'USD',
  });
  assert.strictEqual(calls.pay.length, 0, 'placing never pays');
  assert.ok(/placed AliExpress order 5001 for order 64f0c1e2a3b4c5d6e7f80912/.test(loggedWhenPlacedSaved[0].slice(-1)[0]), 'the AliExpress order number is in the log BEFORE the database is touched');
  const placed = orders.get(OID).aliexpress_order;
  assert.deepStrictEqual([placed.state, placed.ae_order_id, placed.ae_order_ids, placed.pay_state, placed.estimated_cost, placed.currency, placed.shipping_service, placed.finished], ['placed', '5001', ['5001'], 'unpaid', 12.5, 'USD', 'CAINIAO_FULFILLMENT_STD', false]);
  assert.ok(placed.placed_at instanceof Date);

  // placed once: a second click is refused before AliExpress is called
  calls.create.length = 0;
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.strictEqual(out.error, 'blocked');
  assert.ok(out.blockers.some((b) => b.code === 'already_placed'));
  assert.strictEqual(calls.create.length, 0);

  // two clicks at the same moment (both previews pass before either claim): exactly ONE order is created
  reset();
  const both = await Promise.all([S.placeOrder('u1', OID, {}, deps), S.placeOrder('u1', OID, {}, deps)]);
  assert.strictEqual(calls.create.length, 1, 'one AliExpress order, not two');
  assert.deepStrictEqual(both.map((r) => (r.order ? 'placed' : r.error)).sort(), ['claimed', 'placed']);

  // blockers stop it; the overridable ones only when the seller accepted them
  reset(); orders.set(OID, order({ sale_price: 5, delivery_cost: 0 }));
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.strictEqual(out.error, 'blocked');
  assert.strictEqual(out.blockers[0].code, 'loses_money');
  assert.strictEqual(calls.claim.length + calls.create.length, 0, 'nothing claimed, nothing sent');
  out = await S.placeOrder('u1', OID, { allowLoss: true, shownCodes: ['loses_money'] }, deps);
  assert.ok(out.order, 'the seller accepted the loss');
  reset(); orders.set(OID, order({ sale_price: 5, delivery_cost: 0, shipping_address: { fullName: 'Jo', addressLine1: '1 High St', city: 'Leeds', postalCode: '', country: 'GB' } }));
  out = await S.placeOrder('u1', OID, { allowLoss: true, shownCodes: ['loses_money'] }, deps);
  assert.strictEqual(out.error, 'blocked', 'accepting a loss does not excuse a missing postcode');
  assert.strictEqual(calls.create.length, 0);
  reset(); orders.set(OID, order({ fulfillment_status: 'shipped', sale_price: 5, delivery_cost: 0 }));
  assert.strictEqual((await S.placeOrder('u1', OID, { allowLoss: true, confirmNotPlaced: true }, deps)).error, 'blocked', 'neither override can place a shipped order');

  // an address typed in the window is what gets ordered
  reset(); orders.set(OID, order({ shipping_address: { fullName: 'Jo', addressLine1: '1 High St', city: 'Leeds', postalCode: '', country: 'GB' }, buyer_phone: '' }));
  out = await S.placeOrder('u1', OID, { address: { zip: 'LS1 1AA', phone: '+44 7700 900123', line2: 'Flat 2' } }, deps);
  assert.ok(out.order);
  assert.deepStrictEqual([calls.create[0].address.zip, calls.create[0].address.mobile_no, calls.create[0].address.address2], ['LS1 1AA', '7700900123', 'Flat 2']);

  // AliExpress REFUSED: nothing exists; the reason is kept, and the very same order can be tried again after the fix
  reset();
  adapterBehaviour.create = async () => { throw Object.assign(new Error('The address is wrong'), { rejected: true, aliCode: 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL' }); };
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.deepStrictEqual([out.error, out.code], ['refused', 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL']);
  assert.match(out.message, /address is wrong/);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'failed');
  assert.strictEqual(orders.get(OID).aliexpress_order.error_code, 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL');
  assert.ok(!orders.get(OID).aliexpress_order.ae_order_id);
  adapterBehaviour.create = async () => ({ orderIds: ['5002'] });
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.ok(out.order, 'retry after a refusal works');
  assert.strictEqual(orders.get(OID).aliexpress_order.ae_order_id, '5002');
  assert.strictEqual(orders.get(OID).aliexpress_order.error, null, 'the old error is cleared');

  // NO CLEAR ANSWER (timeout, empty answer, a duplicate warning): an order MAY exist -> unknown, and it cannot be retried without the seller's confirmation
  for (const [name, err] of [
    ['timeout', new Error('Could not reach AliExpress: timeout of 20000ms exceeded')],
    ['empty answer', Object.assign(new Error('AliExpress sent back an empty answer. Check your AliExpress orders before trying again.'), { rejected: false })],
    ['duplicate', Object.assign(new Error('Duplicate order'), { rejected: true, aliCode: 'REPEATED_ORDER_ERROR' })],
  ]) {
    reset();
    adapterBehaviour.create = async () => { throw err; };
    out = await S.placeOrder('u1', OID, {}, deps);
    assert.strictEqual(out.error, 'unknown', name);
    assert.strictEqual(orders.get(OID).aliexpress_order.state, 'unknown', name);
    adapterBehaviour.create = async () => ({ orderIds: ['6001'] });
    calls.create.length = 0;
    out = await S.placeOrder('u1', OID, {}, deps);
    assert.strictEqual(out.error, 'blocked', name + ': a plain retry is stopped');
    assert.ok(out.blockers.some((b) => b.code === 'unknown_state'), name);
    assert.strictEqual(calls.create.length, 0, name);
    out = await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['unknown_state'] }, deps);
    assert.ok(out.order, name + ': after the seller checked AliExpress and confirmed');
    assert.deepStrictEqual(calls.claim[calls.claim.length - 1].opts, { retryUnknown: true });
  }
  reset();
  await S.placeOrder('u1', OID, {}, deps);
  assert.deepStrictEqual(calls.claim[0].opts, { retryUnknown: false }, 'a normal place never reclaims an unknown one');

  // CONSENT is for what the seller was shown and ticked (shownCodes), not for whatever the order became afterwards
  reset(); orders.set(OID, order({ fulfillment_status: 'ordered_from_amazon' }));
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: true }, deps)).error, 'blocked', 'no shownCodes: no consent');
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: [] }, deps)).error, 'blocked');
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: 'already_ordered' }, deps)).error, 'blocked', 'a string is not a list');
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['loses_money'] }, deps)).error, 'blocked', 'a tick for another blocker');
  assert.strictEqual((await S.placeOrder('u1', OID, { confirmNotPlaced: false, shownCodes: ['already_ordered'] }, deps)).error, 'blocked', 'shown but the switch is off');
  assert.strictEqual(calls.create.length, 0);
  // tab A showed only "already marked as ordered" and the seller ticked it; meanwhile tab B placed the order, it came back UNCLEAR: the old tick must not cover it
  reset(); orders.set(OID, order({ fulfillment_status: 'ordered_from_amazon', aliexpress_order: { state: 'unknown', error: 'No clear answer.' } }));
  out = await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['already_ordered'] }, deps);
  assert.strictEqual(out.error, 'blocked');
  assert.deepStrictEqual(out.blockers.map((b) => b.code), ['unknown_state'], 'only the blocker nobody ticked is left');
  assert.strictEqual(calls.create.length + calls.claim.length, 0, 'nothing claimed, nothing sent');
  out = await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['already_ordered', 'unknown_state'] }, deps);
  assert.ok(out.order, 'both ticked');
  assert.deepStrictEqual(calls.claim[0].opts, { retryUnknown: true });
  // retryUnknown is only set when the preview itself saw an unclear earlier try - a flag alone never widens the claim
  reset(); orders.set(OID, order({ fulfillment_status: 'ordered_from_amazon' }));
  await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['already_ordered'] }, deps);
  assert.deepStrictEqual(calls.claim[0].opts, { retryUnknown: false });

  // =====================================================================================================================
  // payOrder
  // =====================================================================================================================
  const placedOrder = (extra = {}, over = {}) => order({ aliexpress_order: { state: 'placed', ae_order_id: '5001', ae_order_ids: ['5001'], pay_state: 'unpaid', amount: 12.5, currency: 'USD', ...extra }, ...over });
  const PAY = { confirm: true, expectedAmount: 12.5, expectedCurrency: 'USD' };
  const detailOf = (over = {}) => async () => showPaid(baseDetail(over));
  const silenceErrors = async (work) => { const keep = console.error; const lines = []; console.error = (...a) => lines.push(a.join(' ')); try { return await work(lines); } finally { console.error = keep; } };
  reset(); orders.set(OID, placedOrder());
  out = await S.payOrder('u1', OID, { expectedAmount: 12.5, expectedCurrency: 'USD' }, deps);
  assert.strictEqual(out.error, 'confirm', 'no confirmation, no payment');
  out = await S.payOrder('u1', OID, { ...PAY, confirm: 'yes' }, deps);
  assert.strictEqual(out.error, 'confirm', 'only a real true counts');
  assert.strictEqual(calls.detail.length + calls.pay.length, 0);
  assert.deepStrictEqual(await S.payOrder('u1', 'nope', { confirm: true }, deps), { error: 'not_found' });
  reset();
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'not_placed');

  // the happy path: the seller confirmed 12.50 USD and AliExpress asks 12.50 USD; paid is written only because AliExpress then SHOWS the payment
  reset(); orders.set(OID, placedOrder());
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.ok(out.order && !out.pending);
  assert.deepStrictEqual(calls.pay, ['5001']);
  assert.deepStrictEqual(calls.claimPay, [OID], 'the payment was claimed first');
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid');
  assert.strictEqual(orders.get(OID).aliexpress_order.amount, 12.5);
  assert.deepStrictEqual(calls.releasePay, [], 'a successful payment is not released');
  assert.ok(calls.detail.length >= 2, 'the order is read again after the payment');
  // a second pay never pays twice
  calls.pay.length = 0;
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.alreadyPaid, true);
  assert.strictEqual(calls.pay.length, 0);
  // text amounts from the browser are fine when they are only a number
  reset(); orders.set(OID, placedOrder());
  assert.ok((await S.payOrder('u1', OID, { ...PAY, expectedAmount: '12.50', expectedCurrency: ' usd ' }, deps)).order);

  // "request accepted" is NOT "paid": if AliExpress does not show the payment yet, the order stays 'paying' (pending) - a failed payment
  // (a balance that is too low) can never show as Paid, and a second click is stopped
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.pay = async () => ({ paid: true, message: null }); // accepted, but nothing shows it
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.pending, true);
  assert.match(out.message, /does not show the order as paid yet/);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paying', 'not "paid"');
  assert.strictEqual(orders.get(OID).aliexpress_order.paid_at, undefined);
  calls.pay.length = 0;
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'claimed', 'no second payment while the first is unconfirmed');
  assert.strictEqual(calls.pay.length, 0);
  paidFlag = true; // now AliExpress shows it
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.alreadyPaid, true);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid');
  assert.strictEqual(calls.pay.length, 0);
  // ...and a refresh moves an unconfirmed payment to paid as soon as AliExpress shows it
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:59:00Z') }));
  adapterBehaviour.detail = detailOf({ status: 'FUND_PROCESSING' }); // a status that can only follow paying, even without a payment time
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid');

  // two clicks at the same moment (both read the order as unpaid before either claim): exactly ONE payment is sent
  reset(); orders.set(OID, placedOrder());
  const bothPay = await Promise.all([S.payOrder('u1', OID, PAY, deps), S.payOrder('u1', OID, PAY, deps)]);
  assert.strictEqual(calls.pay.length, 1, 'one payment, not two');
  assert.deepStrictEqual(bothPay.map((r) => (r.order ? 'paid' : r.error)).sort(), ['claimed', 'paid']);

  // AliExpress now asks for MORE than the seller saw: nothing is paid, the new amount comes back
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ amount: 14.9 });
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.deepStrictEqual([out.error, out.amount, out.currency], ['amount_changed', 14.9, 'USD']);
  assert.match(out.message, /14\.90 USD.*not the 12\.50 USD you saw/);
  assert.strictEqual(calls.pay.length + calls.claimPay.length, 0, 'not paid, not even claimed');
  assert.strictEqual(orders.get(OID).aliexpress_order.amount, 14.9, 'the new amount is saved so the window can show it');
  // an amount that is not an amount is never "0 = anything goes": nothing is paid
  for (const bad of [undefined, null, '', ' ', [], false, true, 'abc', NaN, {}, '14.9 USD']) {
    out = await S.payOrder('u1', OID, { confirm: true, expectedAmount: bad, expectedCurrency: 'USD' }, deps);
    assert.strictEqual(out.error, 'amount_changed', JSON.stringify(bad));
    assert.match(out.message, /Confirm that amount to pay/, JSON.stringify(bad));
  }
  assert.strictEqual(calls.pay.length, 0);
  out = await S.payOrder('u1', OID, { ...PAY, expectedAmount: 14.9 }, deps);
  assert.ok(out.order, 'confirming the new amount pays it');
  assert.deepStrictEqual(calls.pay, ['5001']);
  // the amount may be LOWER than the seller saw - still not what they confirmed
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ amount: 11 });
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'amount_changed');
  assert.strictEqual(calls.pay.length, 0);

  // the CURRENCY is confirmed too: the same number in another currency is a different price
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ currency: 'EUR' });
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.deepStrictEqual([out.error, out.currency], ['amount_changed', 'EUR']);
  assert.match(out.message, /12\.50 EUR.*not the 12\.50 USD you saw/);
  out = await S.payOrder('u1', OID, { confirm: true, expectedAmount: 12.5 }, deps);
  assert.strictEqual(out.error, 'amount_changed', 'no currency given: not paid');
  assert.match(out.message, /Confirm that amount to pay/);
  assert.strictEqual(calls.pay.length, 0);
  out = await S.payOrder('u1', OID, { ...PAY, expectedCurrency: 'EUR' }, deps);
  assert.ok(out.order, 'confirming the right currency pays');
  // AliExpress gives no currency: the currency ELMS asked to pay in when it placed the order is what is checked against - never "anything goes"
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ currency: null });
  assert.ok((await S.payOrder('u1', OID, PAY, deps)).order, 'the seller saw USD, ELMS asked for USD');
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ currency: null });
  out = await S.payOrder('u1', OID, { ...PAY, expectedCurrency: 'EUR' }, deps);
  assert.strictEqual(out.error, 'amount_changed', 'the seller confirmed another currency than the one the order was placed in');
  assert.strictEqual(calls.pay.length, 0);
  reset(); orders.set(OID, placedOrder({ currency: null }));
  adapterBehaviour.detail = detailOf({ currency: null });
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.error, 'no_amount', 'no currency anywhere: nothing to check against');
  assert.match(out.message, /currency/);
  assert.strictEqual(calls.pay.length, 0);

  // AliExpress does not say the total, or says 0 (a free order "confirmed" at 0.00 would still be charged the real price): not paid
  for (const amount of [null, 0, -3]) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ amount, currency: null });
    out = await S.payOrder('u1', OID, { confirm: true, expectedAmount: 0, expectedCurrency: 'USD' }, deps);
    assert.strictEqual(out.error, 'no_amount', String(amount));
    assert.strictEqual(calls.pay.length, 0);
  }

  // AliExpress already shows it paid (a payment time, or a status that can only follow paying): marked paid, no second payment
  for (const over of [{ status: 'WAIT_SELLER_SEND_GOODS', paidAt: '2026-10-03T10:00:00-07:00' }, { status: 'FUND_PROCESSING' }, { status: 'WAIT_BUYER_ACCEPT_GOODS' }, { status: 'RISK_CONTROL' }, { status: 'IN_ISSUE' }, { status: 'IN_FROZEN' }, { status: 'PLACE_ORDER_SUCCESS', paidAt: '2026-10-03T10:00:00-07:00' }]) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf(over);
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.alreadyPaid, true, JSON.stringify(over));
    assert.strictEqual(calls.pay.length, 0, JSON.stringify(over));
    assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid', JSON.stringify(over));
  }

  // the line changed while the order was being read (re-placed meanwhile): "paid" is not claimed for the old reading, and nothing is written over the new order
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => { orders.get(OID).aliexpress_order = { state: 'placed', ae_order_id: '6000', ae_order_ids: ['6000'], pay_state: 'unpaid' }; return baseDetail({ status: 'WAIT_SELLER_SEND_GOODS', paidAt: '2026-10-03T10:00:00-07:00' }); };
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.error, 'changed');
  assert.ok(!out.alreadyPaid);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'unpaid');
  assert.strictEqual(calls.pay.length, 0);

  // fail closed: only an order AliExpress shows as WAITING for payment is paid. Anything else - a closed, finished or cancelling order, a
  // status ELMS has never seen, no status at all - is refused (the seller can look at it on AliExpress)
  for (const status of ['FINISH', 'CLOSED', 'IN_CANCEL', 'CANCELED', 'SOMETHING_NEW', '', null]) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ status });
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, 'not_payable', String(status));
    assert.match(out.message, /not as waiting for payment/);
    assert.strictEqual(calls.pay.length + calls.claimPay.length, 0, String(status) + ': nothing claimed, nothing paid');
  }
  for (const status of ['PLACE_ORDER_SUCCESS', 'place_order_success', 'WAIT_BUYER_PAY']) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ status });
    assert.ok((await S.payOrder('u1', OID, PAY, deps)).order, status);
  }

  // what AliExpress created must be what ELMS ordered: exactly one line, this product, this option, this quantity
  for (const [name, lines] of [
    ['no lines listed', []],
    ['two lines', [{ productId: 'P1', skuId: 'S1', quantity: 2 }, { productId: 'P9', skuId: 'S9', quantity: 1 }]],
    ['another product', [{ productId: 'P9', skuId: 'S1', quantity: 2 }]],
    ['another option', [{ productId: 'P1', skuId: 'S2', quantity: 2 }]],
    ['another quantity', [{ productId: 'P1', skuId: 'S1', quantity: 1 }]],
    ['no quantity', [{ productId: 'P1', skuId: 'S1', quantity: null }]],
  ]) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ lines });
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, 'wrong_item', name);
    assert.match(out.message, /not what ELMS meant to order/, name);
    assert.strictEqual(calls.pay.length + calls.claimPay.length, 0, name + ': not paid');
  }
  reset(); orders.set(OID, placedOrder({}, { listing_id: 'GONE' }));
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'wrong_item', 'without the listing there is nothing to compare with');
  assert.strictEqual(S.itemMismatch(baseDetail(), listings.get('L1'), order()), null);
  assert.strictEqual(S.itemMismatch(baseDetail({ lines: [{ productId: 'P1', skuId: 'S1', quantity: '2' }] }), listings.get('L1'), order()), null, 'a quantity that arrives as text is still the same quantity');

  // a shipped order is not paid for
  reset(); orders.set(OID, placedOrder({}, { order_status: 'shipped' }));
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'shipped');
  reset(); orders.set(OID, placedOrder({}, { fulfillment_status: 'delivered' }));
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'shipped');
  assert.strictEqual(calls.pay.length + calls.claimPay.length + calls.detail.length, 0);

  // the buyer cancelled / was refunded / never paid since the order was placed: not paid (days may pass between the two clicks)
  for (const [name, over, code] of [
    ['cancelled', { ebay_cancel_status: 'CANCELED' }, 'cancelled'],
    ['cancel requested', { ebay_cancel_status: 'CANCEL_REQUESTED' }, 'cancelled'],
    ['cancelled (as eBay shows it)', { order_status: 'cancelled' }, 'cancelled'],
    ['refunded', { ebay_payment_status: 'FULLY_REFUNDED' }, 'not_paid'],
    ['part refunded', { ebay_payment_status: 'PARTIALLY_REFUNDED' }, 'not_paid'],
    ['payment pending', { ebay_payment_status: 'PENDING' }, 'not_paid'],
    ['awaiting payment', { order_status: 'awaiting_payment' }, 'not_paid'],
  ]) {
    reset(); orders.set(OID, placedOrder({}, over));
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, code, name);
    assert.strictEqual(calls.pay.length + calls.claimPay.length + calls.detail.length, 0, name + ': AliExpress was not even asked');
  }

  // an order AliExpress split into several: ELMS does not pay half of it - the seller does, on AliExpress
  for (const ids of [['5001', '5002'], ['5001', '5001', '5003'], ['5002']]) {
    reset(); orders.set(OID, placedOrder({ ae_order_ids: ids }));
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, 'multiple', JSON.stringify(ids));
    assert.match(out.message, /pay them on AliExpress/);
    assert.strictEqual(calls.pay.length + calls.claimPay.length + calls.detail.length, 0, 'nothing was paid or even read');
  }
  reset(); orders.set(OID, placedOrder({ ae_order_ids: ['5001', '5001'] })); // the same number twice is ONE order
  assert.ok((await S.payOrder('u1', OID, PAY, deps)).order);

  // AliExpress ANSWERS that it did not take the payment: the claim is given back, so the seller can fix the balance and pay again
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.pay = async () => ({ paid: false, message: 'Insufficient balance' });
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.deepStrictEqual([out.error, out.message], ['not_accepted', 'Insufficient balance']);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'unpaid');
  adapterBehaviour.pay = async () => ({ paid: false, message: null });
  assert.match((await S.payOrder('u1', OID, PAY, deps)).message, /balance \/ payment method/);
  adapterBehaviour.pay = payAccepted;
  assert.ok((await S.payOrder('u1', OID, PAY, deps)).order, 'and it can be paid afterwards');
  // turned away before any payment logic ran (rejected = true): also given back
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.pay = async () => { throw Object.assign(new Error('The AliExpress session expired.'), { rejected: true }); };
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.deepStrictEqual([out.error, out.message, orders.get(OID).aliexpress_order.pay_state], ['not_accepted', 'The AliExpress session expired.', 'unpaid']);

  // NO CLEAR ANSWER (timeout, unreadable answer): the payment MAY have gone through. It is neither marked paid nor given back; a second click
  // is stopped (claimed) until the order is checked - or until 5 minutes passed, and then it is read first anyway
  for (const [name, err] of [['timeout', new Error('Could not reach AliExpress: timeout of 20000ms exceeded')], ['unreadable', Object.assign(new Error('AliExpress sent back an answer ELMS cannot read.'), { rejected: false })]]) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.pay = async () => { throw err; };
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, 'pay_unclear', name);
    assert.match(out.message, /Do NOT pay again yet/, name);
    assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paying', name);
    assert.deepStrictEqual(calls.releasePay, [], name + ': the claim is kept');
    adapterBehaviour.pay = payAccepted;
    calls.pay.length = 0;
    out = await S.payOrder('u1', OID, PAY, deps);
    assert.strictEqual(out.error, 'claimed', name + ': an immediate second click is stopped');
    assert.strictEqual(calls.pay.length, 0, name);
  }
  // the unclear payment DID go through: the next read shows the payment and it is marked paid, never paid again
  paidFlag = true;
  calls.pay.length = 0;
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(out.alreadyPaid, true);
  assert.strictEqual(calls.pay.length, 0);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid');
  // an old "paying" (the server stopped mid-request) can be paid again - after reading the order
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:40:00Z') })); // 20 minutes before deps.now()
  assert.ok((await S.payOrder('u1', OID, PAY, deps)).order);
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:58:00Z') })); // 2 minutes: still in flight
  assert.strictEqual((await S.payOrder('u1', OID, PAY, deps)).error, 'claimed');
  assert.strictEqual(calls.pay.length, 0);

  // the writes that follow money are retried: a database hiccup after the payment / the order does not lose it
  reset(); orders.set(OID, placedOrder());
  updateFailures = 2;
  out = await S.payOrder('u1', OID, PAY, deps);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid', 'saved on the third try');
  reset(); orders.set(OID, placedOrder());
  updateFailures = 3;
  await silenceErrors(async (lines) => {
    await assert.rejects(() => S.payOrder('u1', OID, PAY, deps), (err) => err.irreversible === true && /The payment WAS sent to AliExpress \(order 5001\).*Do not pay again/.test(err.message));
    assert.ok(lines.some((l) => /PAYMENT SENT for AliExpress order 5001/.test(l)), 'the numbers are in the log when the save finally fails');
  });
  assert.strictEqual(calls.pay.length, 1, 'and nothing was paid twice');

  // =====================================================================================================================
  // refreshOrder
  // =====================================================================================================================
  reset();
  assert.deepStrictEqual(await S.refreshOrder('u1', 'nope', deps), { error: 'not_found' });
  assert.strictEqual((await S.refreshOrder('u1', OID, deps)).error, 'not_placed');
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'unknown' } }));
  assert.strictEqual((await S.refreshOrder('u1', OID, deps)).error, 'not_placed', 'an order that may not exist is not read back');
  assert.strictEqual(calls.detail.length, 0);

  // unpaid: status and total saved; an unpaid order cannot have shipped, so AliExpress's tracking is not asked for
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => ({ status: 'PLACE_ORDER_SUCCESS', logisticsStatus: null, amount: 12.5, currency: 'USD', paidAt: null, logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(calls.tracking.length, 0);
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'unpaid', 'AliExpress shows no payment time: still unpaid');

  // closed / cancelled BEFORE it was ever paid: nothing was bought, so the line goes back to "not placed" and can be placed again
  for (const status of ['CLOSED', 'CANCELED', 'CANCELLED', 'Closed']) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ status });
    out = await S.refreshOrder('u1', OID, deps);
    assert.strictEqual(out.reset, true, status);
    const closed = orders.get(OID).aliexpress_order;
    assert.deepStrictEqual([closed.state, closed.pay_state, closed.finished, closed.error_code], ['failed', 'unpaid', true, 'CLOSED_UNPAID'], status);
    assert.match(closed.error, /closed without being paid, so nothing was bought.*place it again/, status);
    assert.strictEqual(calls.tracking.length, 0, status);
    adapterBehaviour.create = async () => ({ orderIds: ['5900'] });
    out = await S.placeOrder('u1', OID, {}, deps);
    assert.ok(out.order, status + ': the same line can be ordered again');
    assert.deepStrictEqual([orders.get(OID).aliexpress_order.state, orders.get(OID).aliexpress_order.ae_order_id, orders.get(OID).aliexpress_order.finished], ['placed', '5900', false]);
  }
  // ...but never when anything shows it was PAID (AliExpress's payment time, or ELMS's own paid / paying mark): that money is still out there
  for (const [name, saved, over] of [['AliExpress shows a payment time', {}, { paidAt: '2026-10-03T10:00:00-07:00' }], ['ELMS saved it as paid', { pay_state: 'paid' }, {}], ['a payment is in flight', { pay_state: 'paying' }, {}]]) {
    reset(); orders.set(OID, placedOrder(saved));
    adapterBehaviour.detail = detailOf({ status: 'CLOSED', ...over });
    out = await S.refreshOrder('u1', OID, deps);
    assert.ok(!out.reset, name);
    assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed', name + ': stays placed');
    assert.strictEqual(orders.get(OID).aliexpress_order.finished, true, name + ': finished, not asked again');
  }
  // "in cancellation" is not closed yet
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ status: 'IN_CANCEL' });
  assert.ok(!(await S.refreshOrder('u1', OID, deps)).reset);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed');

  // paid but not shipped yet ("WAIT_SELLER_SEND_GOODS" = waiting for the seller to send - the word SEND does not mean it shipped): the
  // shipment is asked for, none exists, so no tracking number is saved
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => ({ status: 'WAIT_SELLER_SEND_GOODS', logisticsStatus: 'WAIT_SELLER_SEND_GOODS', amount: 12.5, currency: 'USD', paidAt: '2026-10-03T10:00:00-07:00', logistics: [], lines: [] });
  out = await S.refreshOrder('u1', OID, deps);
  let ae = orders.get(OID).aliexpress_order;
  assert.deepStrictEqual([ae.status, ae.amount, ae.pay_state, ae.finished, ae.tracking_number], ['WAIT_SELLER_SEND_GOODS', 12.5, 'paid', false, undefined]);
  assert.ok(ae.synced_at instanceof Date);
  assert.strictEqual(calls.tracking.length, 1);

  // paid, whatever the status words say ("FUND_PROCESSING" has no "ship" in it): the shipment is still asked for - status words are not guessed from
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => ({ status: 'FUND_PROCESSING', logisticsStatus: null, amount: 12.5, currency: 'USD', paidAt: '2026-10-03T10:00:00-07:00', logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(calls.tracking.length, 1);
  // ...and an order already saved as paid is asked even if AliExpress forgot to send the payment time
  reset(); orders.set(OID, placedOrder({ pay_state: 'paid' }));
  adapterBehaviour.detail = async () => ({ status: 'FUND_PROCESSING', logisticsStatus: null, amount: 12.5, currency: 'USD', paidAt: null, logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(calls.tracking.length, 1);
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => ({ status: 'PLACE_ORDER_SUCCESS', logisticsStatus: 'WAIT_SELLER_SEND_GOODS', amount: 12.5, currency: 'USD', paidAt: null, logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(calls.tracking.length, 0, 'unpaid: not asked, even though the logistics status contains "SEND"');
  assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'unpaid');
  // a status that can only follow paying counts as paid even without a payment time - and an unknown word never does
  for (const status of ['FUND_PROCESSING', 'WAIT_SELLER_SEND_GOODS', 'SELLER_PART_SEND_GOODS', 'WAIT_BUYER_ACCEPT_GOODS', 'WAIT_SELLER_EXAMINE_MONEY', 'RISK_CONTROL', 'IN_ISSUE', 'IN_FROZEN']) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ status });
    await S.refreshOrder('u1', OID, deps);
    assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'paid', status);
    assert.ok(orders.get(OID).aliexpress_order.paid_at instanceof Date, status);
  }
  for (const status of ['SOMETHING_NEW', 'IN_CANCEL', 'PLACE_ORDER_SUCCESS', 'WAIT_BUYER_PAY']) {
    reset(); orders.set(OID, placedOrder());
    adapterBehaviour.detail = detailOf({ status });
    await S.refreshOrder('u1', OID, deps);
    assert.strictEqual(orders.get(OID).aliexpress_order.pay_state, 'unpaid', status + ': never guessed to be paid');
  }
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => ({ status: 'WAIT_SELLER_SEND_GOODS', logisticsStatus: 'WAIT_SELLER_SEND_GOODS', amount: 12.5, currency: 'USD', paidAt: '2026-10-03T10:00:00-07:00', logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);

  // shipped: the tracking number, carrier, ETA and last event are saved
  adapterBehaviour.detail = async () => ({ status: 'WAIT_BUYER_ACCEPT_GOODS', logisticsStatus: 'SELLER_SEND_GOODS', amount: 12.5, currency: 'USD', paidAt: 'x', logistics: [{ service: 'EMS', number: 'CP1' }], lines: [] });
  adapterBehaviour.tracking = async () => [{ trackingNumber: '62727952231', carrier: 'AliExpress Selection Standard', etaMs: 1720514236934, lastEvent: 'Package delivered' }];
  await S.refreshOrder('u1', OID, deps);
  ae = orders.get(OID).aliexpress_order;
  assert.deepStrictEqual([ae.tracking_number, ae.carrier, ae.last_event, ae.finished], ['62727952231', 'AliExpress Selection Standard', 'Package delivered', false]);
  assert.strictEqual(ae.eta_at.getTime(), 1720514236934);
  // the tracking lookup fails later: the carrier's number already saved is NOT swapped for the order detail's internal one
  adapterBehaviour.tracking = async () => { throw new Error('TRACKING DATA NOT FOUND'); };
  await S.refreshOrder('u1', OID, deps);
  assert.deepStrictEqual([orders.get(OID).aliexpress_order.tracking_number, orders.get(OID).aliexpress_order.carrier], ['62727952231', 'AliExpress Selection Standard']);
  // ...and when no number is saved yet, the order detail's number is NOT used in its place: it may be AliExpress's internal one, and a saved
  // number can be sent to the buyer. Only the carrier's own number from the tracking lookup is ever saved.
  reset(); orders.set(OID, placedOrder({ pay_state: 'paid' }));
  adapterBehaviour.detail = async () => ({ status: 'WAIT_BUYER_ACCEPT_GOODS', logisticsStatus: 'SELLER_SEND_GOODS', amount: 12.5, currency: 'USD', paidAt: 'x', logistics: [{ service: 'EMS', number: 'CP1' }], lines: [] });
  adapterBehaviour.tracking = async () => { throw new Error('TRACKING DATA NOT FOUND'); };
  await S.refreshOrder('u1', OID, deps);
  assert.deepStrictEqual([orders.get(OID).aliexpress_order.tracking_number, orders.get(OID).aliexpress_order.carrier], [undefined, undefined]);
  // finished
  adapterBehaviour.detail = async () => ({ status: 'FINISH', logisticsStatus: 'BUYER_ACCEPT_GOODS', amount: 12.5, currency: 'USD', paidAt: 'x', logistics: [], lines: [] });
  await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(orders.get(OID).aliexpress_order.finished, true, 'no need to ask again');
  // nothing back
  adapterBehaviour.detail = async () => null;
  assert.strictEqual((await S.refreshOrder('u1', OID, deps)).error, 'not_placed');

  // every refresh write is conditional on the line still holding the same placed order
  reset(); orders.set(OID, placedOrder());
  await S.refreshOrder('u1', OID, deps);
  assert.deepStrictEqual(calls.guards[calls.guards.length - 1], { state: 'placed', aeOrderId: '5001' });

  // a slow refresh must not overwrite what happened meanwhile: it read A1 as closed, but by the time it writes, the seller has re-placed (A2)
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => {
    orders.get(OID).aliexpress_order = { state: 'placed', ae_order_id: '6000', ae_order_ids: ['6000'], pay_state: 'unpaid' }; // A2 was placed while we were reading
    return baseDetail({ status: 'CLOSED' });
  };
  out = await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(out.error, 'changed');
  assert.deepStrictEqual([orders.get(OID).aliexpress_order.state, orders.get(OID).aliexpress_order.ae_order_id], ['placed', '6000'], 'the new order is untouched');
  // ...nor reset a line whose payment started in the meantime
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => { orders.get(OID).aliexpress_order.pay_state = 'paying'; return baseDetail({ status: 'CLOSED' }); };
  out = await S.refreshOrder('u1', OID, deps);
  assert.strictEqual(out.error, 'changed');
  assert.deepStrictEqual([orders.get(OID).aliexpress_order.state, orders.get(OID).aliexpress_order.pay_state], ['placed', 'paying']);

  // finished with every line ended and no payment shown = closed unpaid too (some closes may arrive as FINISH)
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = detailOf({ status: 'FINISH', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'buyer_cancel_notpay_order' }] });
  assert.strictEqual((await S.refreshOrder('u1', OID, deps)).reset, true);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'failed');
  for (const [name, saved, over] of [
    ['a normal finished order has no ended lines', {}, { status: 'FINISH', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: null }] }],
    ['a finished order shows its payment', {}, { status: 'FINISH', paidAt: '2026-10-03T10:00:00-07:00', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'x' }] }],
    ['ELMS saved it as paid', { pay_state: 'paid' }, { status: 'FINISH', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'x' }] }],
    ['no lines listed', {}, { status: 'FINISH', lines: [] }],
  ]) {
    reset(); orders.set(OID, placedOrder(saved));
    adapterBehaviour.detail = detailOf(over);
    assert.ok(!(await S.refreshOrder('u1', OID, deps)).reset, name);
    assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed', name);
  }

  // AliExpress split it into several orders: only the first is read, so nothing about the WHOLE is concluded - no reset, no "paid"
  for (const [name, over] of [['first one closed', { status: 'CLOSED' }], ['first one paid', { paidAt: '2026-10-03T10:00:00-07:00', status: 'WAIT_SELLER_SEND_GOODS' }], ['first one finished', { status: 'FINISH' }]]) {
    reset(); orders.set(OID, placedOrder({ ae_order_ids: ['5001', '5002'] }));
    adapterBehaviour.detail = detailOf(over);
    out = await S.refreshOrder('u1', OID, deps);
    assert.strictEqual(out.multiple, true, name);
    const split = orders.get(OID).aliexpress_order;
    assert.deepStrictEqual([split.state, split.pay_state, split.finished, split.error_code], ['placed', 'unpaid', false, undefined], name);
    assert.ok(split.synced_at instanceof Date, name);
    assert.strictEqual(calls.tracking.length, 0, name);
  }

  // a parcel (or a saved tracking number) means the goods may arrive: such an order is never "closed unpaid", whatever its status says
  for (const [name, saved, over] of [
    ['closed but AliExpress lists a parcel', {}, { status: 'CLOSED', logistics: [{ service: 'EMS', number: 'LP1' }] }],
    ['closed but it has a logistics status', {}, { status: 'CLOSED', logisticsStatus: 'SELLER_SEND_GOODS' }],
    ['closed but a tracking number was saved', { tracking_number: 'T1' }, { status: 'CLOSED' }],
    ['finished and delivered (the sample of a normal order)', {}, { status: 'FINISH', logisticsStatus: 'BUYER_ACCEPT_GOODS', logistics: [{ service: 'EMS', number: 'LP1' }], lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'buyer_confirm_goods' }] }],
    ['finished, no parcel listed, but the line ended by a confirmed delivery', {}, { status: 'FINISH', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'buyer_confirm_goods' }] }],
    ['finished, line ended by "completed"', {}, { status: 'FINISH', lines: [{ productId: 'P1', skuId: 'S1', quantity: 2, endReason: 'order_completed' }] }],
  ]) {
    reset(); orders.set(OID, placedOrder(saved));
    adapterBehaviour.detail = detailOf(over);
    assert.ok(!(await S.refreshOrder('u1', OID, deps)).reset, name);
    assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed', name + ': stays placed');
  }
  // a payment request "in flight" for far too long on an order AliExpress has since CLOSED was never paid: the line is freed (a fresh one is not)
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:20:00Z') })); // 40 minutes before deps.now()
  adapterBehaviour.detail = detailOf({ status: 'CLOSED' });
  assert.strictEqual((await S.refreshOrder('u1', OID, deps)).reset, true, 'abandoned payment on a closed order');
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'failed');
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:40:00Z') })); // 20 minutes: not abandoned yet
  adapterBehaviour.detail = detailOf({ status: 'CLOSED' });
  assert.ok(!(await S.refreshOrder('u1', OID, deps)).reset);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed');
  reset(); orders.set(OID, placedOrder({ pay_state: 'paying', paying_at: new Date('2026-10-03T11:20:00Z') })); // abandoned, but AliExpress shows a payment: money is out there
  adapterBehaviour.detail = detailOf({ status: 'CLOSED', paidAt: '2026-10-03T10:00:00-07:00' });
  assert.ok(!(await S.refreshOrder('u1', OID, deps)).reset);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed');

  // placing and saving: the write that records a created order is retried; if it never lands, the numbers are in the log and the error is raised
  reset();
  updateFailures = 2;
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed', 'saved on the third try');
  reset();
  updateFailures = 3;
  await silenceErrors(async (lines) => {
    await assert.rejects(() => S.placeOrder('u1', OID, {}, deps), (err) => err.irreversible === true && /The AliExpress order 5001 WAS created, but ELMS could not save it.*Do not order again/.test(err.message));
    assert.ok(lines.some((l) => /AliExpress order 5001 EXISTS for order/.test(l)), 'the order numbers are in the log');
  });
  assert.strictEqual(calls.create.length, 1, 'and the order was created once');

  // a refresh never reaches eBay, the buyer or the order's own tracking: only the AliExpress record changes
  assert.ok(calls.update.every((p) => Object.keys(p).every((k) => ['status', 'logisticsStatus', 'syncedAt', 'finished', 'amount', 'currency', 'payState', 'payingAt', 'paidAt', 'trackingNumber', 'carrier', 'etaAt', 'lastEvent', 'state', 'aeOrderId', 'aeOrderIds', 'outOrderId', 'placedAt', 'estimatedCost', 'shippingService', 'error', 'errorCode'].includes(k))));

  // =====================================================================================================================
  // releaseOrder: "this AliExpress order is dead - let me order again" (the one thing ELMS cannot tell by itself: e.g. a paid order the supplier cancelled)
  // =====================================================================================================================
  reset(); orders.set(OID, placedOrder({ pay_state: 'paid', amount: 12.5 }));
  adapterBehaviour.detail = detailOf({ status: 'CLOSED', paidAt: '2026-10-03T10:00:00-07:00' });
  assert.strictEqual((await S.releaseOrder('u1', OID, {}, deps)).error, 'confirm', 'needs the seller\'s confirmation');
  assert.strictEqual((await S.releaseOrder('u1', OID, { confirm: 'yes' }, deps)).error, 'confirm');
  assert.strictEqual(calls.detail.length, 0, 'AliExpress is not even asked without it');
  assert.deepStrictEqual(await S.releaseOrder('u1', 'nope', { confirm: true }, deps), { error: 'not_found' });
  out = await S.releaseOrder('u1', OID, { confirm: true }, deps);
  assert.ok(out.order, 'a paid order AliExpress shows as closed (cancelled and refunded) can be released');
  let rel = orders.get(OID).aliexpress_order;
  assert.deepStrictEqual([rel.state, rel.pay_state, rel.finished, rel.error_code], ['failed', 'unpaid', true, 'RELEASED']);
  assert.match(rel.error, /You released the AliExpress order 5001.*CLOSED.*place a new order/);
  assert.deepStrictEqual(calls.guards[calls.guards.length - 1], { state: 'placed', aeOrderId: '5001' });
  assert.ok(serviceLogs.some((l) => /released AliExpress order 5001/.test(l)));
  // ...and the line can be ordered again, with its own out_order_id
  adapterBehaviour.create = async () => ({ orderIds: ['5900'] });
  out = await S.placeOrder('u1', OID, {}, deps);
  assert.ok(out.order);
  assert.notStrictEqual(calls.create[0].outOrderId, S.outOrderIdFor(OID), 'a new purchase is not sent under the dead order\'s out_order_id');
  assert.strictEqual(calls.create[0].outOrderId, S.outOrderIdFor(OID, '5001'));
  assert.deepStrictEqual([orders.get(OID).aliexpress_order.status, orders.get(OID).aliexpress_order.amount, orders.get(OID).aliexpress_order.tracking_number, orders.get(OID).aliexpress_order.paid_at, orders.get(OID).aliexpress_order.synced_at], [null, null, null, null, null], 'nothing of the dead order is left on the line');
  // refused: not dead yet, a parcel exists, shipped on eBay, split, never placed
  for (const [name, saved, over, orderOver, code] of [
    ['still waiting for payment', {}, { status: 'PLACE_ORDER_SUCCESS' }, {}, 'release_blocked'],
    ['paid and processing', {}, { status: 'WAIT_SELLER_SEND_GOODS' }, {}, 'release_blocked'],
    ['in cancellation', {}, { status: 'IN_CANCEL' }, {}, 'release_blocked'],
    ['no status', {}, { status: null }, {}, 'release_blocked'],
    ['finished with a parcel', {}, { status: 'FINISH', logistics: [{ service: 'EMS', number: 'LP1' }] }, {}, 'release_blocked'],
    ['finished with a logistics status', {}, { status: 'FINISH', logisticsStatus: 'BUYER_ACCEPT_GOODS' }, {}, 'release_blocked'],
    ['closed, but a tracking number is saved', { tracking_number: 'T1' }, { status: 'CLOSED' }, {}, 'release_blocked'],
    ['shipped on eBay', {}, { status: 'CLOSED' }, { order_status: 'shipped' }, 'shipped'],
    ['split into several', { ae_order_ids: ['5001', '5002'] }, { status: 'CLOSED' }, {}, 'multiple'],
  ]) {
    reset(); orders.set(OID, placedOrder(saved, orderOver));
    adapterBehaviour.detail = detailOf(over);
    out = await S.releaseOrder('u1', OID, { confirm: true }, deps);
    assert.strictEqual(out.error, code, name);
    assert.strictEqual(orders.get(OID).aliexpress_order.state, 'placed', name + ': nothing changed');
  }
  reset();
  assert.strictEqual((await S.releaseOrder('u1', OID, { confirm: true }, deps)).error, 'not_placed');
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => null;
  assert.strictEqual((await S.releaseOrder('u1', OID, { confirm: true }, deps)).error, 'release_blocked');
  // changed while it was being read: not released
  reset(); orders.set(OID, placedOrder());
  adapterBehaviour.detail = async () => { orders.get(OID).aliexpress_order = { state: 'placed', ae_order_id: '6000', ae_order_ids: ['6000'], pay_state: 'unpaid' }; return baseDetail({ status: 'CLOSED' }); };
  assert.strictEqual((await S.releaseOrder('u1', OID, { confirm: true }, deps)).error, 'changed');
  assert.strictEqual(orders.get(OID).aliexpress_order.ae_order_id, '6000');

  // out_order_id: the same for a retry after an unclear answer (de-duplication wanted), its own after a CONFIRMED dead order
  assert.strictEqual(S.outOrderIdFor(OID), S.outOrderIdFor(OID, null));
  assert.strictEqual(S.outOrderIdFor(OID, '8123456789012345').length, S.outOrderIdFor(OID).length, 'same length');
  assert.strictEqual(S.outOrderIdFor(OID, '8123456789012345').slice(0, -2), S.outOrderIdFor(OID).slice(0, -2));
  assert.strictEqual(S.outOrderIdFor(OID, '8123456789012345').slice(-2), '45');
  assert.match(S.outOrderIdFor(OID, '8123456789012345'), /^\d{1,18}$/);
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'unknown', error: 'No clear answer.', error_code: null, out_order_id: S.outOrderIdFor(OID), ae_order_id: '8123456789012399' } })); // (an older, dead order's number may still be on the line)
  await S.placeOrder('u1', OID, { confirmNotPlaced: true, shownCodes: ['unknown_state'] }, deps);
  assert.strictEqual(calls.create[0].outOrderId, S.outOrderIdFor(OID), 'an unclear earlier try is retried under the SAME out_order_id');
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'failed', error: 'refused', error_code: 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL', ae_order_id: '8123456789012399' } }));
  await S.placeOrder('u1', OID, {}, deps);
  assert.strictEqual(calls.create[0].outOrderId, S.outOrderIdFor(OID), 'a refusal (nothing exists) is retried under the same one too');
  reset(); orders.set(OID, order({ aliexpress_order: { state: 'failed', error_code: 'CLOSED_UNPAID', ae_order_id: '8123456789012399' } }));
  await S.placeOrder('u1', OID, {}, deps);
  assert.strictEqual(calls.create[0].outOrderId, S.outOrderIdFor(OID, '8123456789012399'), 'after a closed order: its own');

  console.log('aliexpress order service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
