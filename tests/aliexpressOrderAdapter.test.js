// services/aliexpressAdapter.js createOrder / payOrder / getOrderDetail / getOrderTracking and services/aliexpressSkuHelpers.js
// skuAttrForOrder: the requests are the shapes AliExpress's own API reference pages document (aliexpress.ds.order.create,
// .afterpay, aliexpress.trade.ds.order.get, aliexpress.ds.order.tracking.get), the answers are read from their sample answers, and
// the one thing that matters most - telling "AliExpress refused (nothing was placed)" from "no clear answer (an order MAY exist)" -
// is checked on every path. The real adapter runs; only AliExpress's network layer is a stand-in.
const assert = require('assert');

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const business = [];
let businessAnswer = async () => ({});
stub('../services/aliexpressAuthService', {
  callBusinessApi: async (method, accessToken, params) => { business.push({ method, accessToken, params }); return businessAnswer(); },
  refreshAccessToken: async () => { throw new Error('refresh failed'); },
});
const FAR = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const creds = new Map([['u1', { accessToken: 'AT1', refreshToken: 'RT1', accessTokenExpiresAt: FAR }]]);
stub('../models/usersModel', { getAliexpressCredentials: async (id) => creds.get(id) || null, setAliexpressTokens: async () => {} });

const adapter = require('../services/aliexpressAdapter');
const { skuAttrForOrder, skuStock, skuPrice, skuAttrIsClear } = require('../services/aliexpressSkuHelpers');

const ADDRESS = { contact_person: 'Jo Smith', full_name: 'Jo Smith', address: '1 High St', city: 'Leeds', province: 'West Yorkshire', zip: 'LS1 1AA', country: 'GB', mobile_no: '7700900123', phone_country: '+44', locale: 'en_US' };
const ORDER = { items: [{ productId: '1005003784285827', skuAttr: '73:175;71:193', quantity: 2, logisticsServiceName: 'CAINIAO_FULFILLMENT_STD' }], address: ADDRESS, outOrderId: '123456789', payCurrency: 'USD' };

(async () => {
  // ---------- skuAttrForOrder: the option names after "#" are dropped, the property:value pairs kept ----------
  assert.strictEqual(skuAttrForOrder('73:175#Black Green;71:193#Polarized'), '73:175;71:193', "the sku_attr of AliExpress's own product.get sample");
  assert.strictEqual(skuAttrForOrder('14:70221'), '14:70221', "the order API's own example is kept as it is");
  assert.strictEqual(skuAttrForOrder(''), '');
  assert.strictEqual(skuAttrForOrder(null), '');
  assert.strictEqual(skuAttrForOrder('junk;;12:34#x; ;a:b'), '12:34', 'anything that is not property:value is dropped');
  // skuAttrIsClear: skuAttrForOrder keeps EVERY part (a dropped part would order a different option)
  for (const clear of ['', null, undefined, '14:70221', '73:175#Black Green;71:193#Polarized', ' 14:1 ; 5:2#x ', '14:1;']) assert.strictEqual(skuAttrIsClear(clear), true, JSON.stringify(clear));
  for (const unclear of ['junk', 'junk;;12:34#x', '14:771#white;5:custom text', 'Red / Large', '12:34;a:b', '14:']) assert.strictEqual(skuAttrIsClear(unclear), false, JSON.stringify(unclear));
  assert.strictEqual(skuStock({ sku_available_stock: '57' }), 57);
  assert.strictEqual(skuStock({}), null);
  assert.strictEqual(skuPrice({ offer_sale_price: '3.94', sku_price: '5' }), 3.94);

  // ---------- createOrder: the documented request ----------
  businessAnswer = async () => ({ error_msg: 'PARM_ILLEGL', error_code: 'PARM_ILLEGL', is_success: 'true', order_list: [1000000000] }); // AliExpress's own sample answer (it carries both)
  const created = await adapter.createOrder('u1', ORDER);
  assert.deepStrictEqual(created, { orderIds: ['1000000000'] });
  assert.strictEqual(business[0].method, 'aliexpress.ds.order.create');
  assert.strictEqual(business[0].accessToken, 'AT1');
  assert.deepStrictEqual(Object.keys(business[0].params).sort(), ['ds_extend_request', 'param_place_order_request4_open_api_d_t_o']);
  const request = JSON.parse(business[0].params.param_place_order_request4_open_api_d_t_o);
  assert.deepStrictEqual(request.product_items, [{ product_id: '1005003784285827', product_count: '2', logistics_service_name: 'CAINIAO_FULFILLMENT_STD', sku_attr: '73:175;71:193' }]);
  assert.deepStrictEqual(request.logistics_address, ADDRESS);
  assert.strictEqual(request.out_order_id, '123456789');
  assert.deepStrictEqual(JSON.parse(business[0].params.ds_extend_request), { payment: { try_to_pay: 'false', pay_currency: 'USD' } }, 'created UNPAID: paying is a separate, confirmed step');

  // an option-less product sends no sku_attr; no outOrderId / currency sends none
  business.length = 0;
  await adapter.createOrder('u1', { items: [{ productId: '9', quantity: 1, logisticsServiceName: 'X' }], address: ADDRESS });
  assert.ok(!('sku_attr' in JSON.parse(business[0].params.param_place_order_request4_open_api_d_t_o).product_items[0]));
  assert.ok(!('out_order_id' in JSON.parse(business[0].params.param_place_order_request4_open_api_d_t_o)));
  assert.deepStrictEqual(JSON.parse(business[0].params.ds_extend_request), { payment: { try_to_pay: 'false' } });

  // the answer one level deeper (result.result) is read too; several order numbers are all kept
  businessAnswer = async () => ({ result: { is_success: true, order_list: [1000000011, 1000000022] } });
  assert.deepStrictEqual((await adapter.createOrder('u1', ORDER)).orderIds, ['1000000011', '1000000022']);
  // 16-digit numbers arrive as strings (services/jsonLongInts.js) and stay exact
  businessAnswer = async () => ({ is_success: 'true', order_list: ['8123456789012345'] });
  assert.deepStrictEqual((await adapter.createOrder('u1', ORDER)).orderIds, ['8123456789012345']);
  // an entry that is not an order number is never stored as "the order": null / 0 / text / a short number -> unclear, never placed
  for (const bad of [[null], [0], ['null'], ['abc'], [12], [''], [1000000011, null], [[]], [{}]]) {
    businessAnswer = async () => ({ is_success: 'true', order_list: bad });
    await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === false && /did not give its number/.test(err.message), JSON.stringify(bad));
  }

  // ---------- AliExpress REFUSED (error_code / error_msg): rejected = true, nothing was placed ----------
  businessAnswer = async () => ({ is_success: 'false', error_code: 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL', error_msg: 'The address is wrong' });
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => {
    assert.strictEqual(err.rejected, true);
    assert.strictEqual(err.aliCode, 'B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL');
    assert.strictEqual(err.message, 'The address is wrong');
    return true;
  });
  businessAnswer = async () => ({ result: { is_success: 'false', error_msg: 'Out of stock' } }); // a reason alone (no code) is still a stated refusal
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === true && err.aliCode === 'ORDER_NOT_CREATED' && err.message === 'Out of stock');

  // ---------- NOT clear: the order MAY exist, so rejected is never true ----------
  businessAnswer = async () => ({ is_success: 'true', order_list: [] });
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === false && /Check your AliExpress orders/.test(err.message));
  businessAnswer = async () => null;
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === false);
  businessAnswer = async () => 'surprise';
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === false);
  businessAnswer = async () => { throw new Error('Could not reach AliExpress: timeout of 20000ms exceeded'); }; // no answer at all
  await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected !== true && !err.aliCode);

  // a REFUSAL needs evidence: every answer below proves nothing about whether an order exists, so none of them may be called a refusal
  // (that would let the seller retry and buy the same item twice)
  for (const [name, answerValue] of [
    ['empty object', {}],
    ['no flag, no result', { request_id: '0ba2', code: '0' }],
    ['an error_response of another shape', { error_response: { code: 15, msg: 'Remote service error' } }],
    ['an array', []],
    ['failure flag but an order number listed', { is_success: false, order_list: [123], error_code: 'X' }],
    ['failure flag, no reason at all', { is_success: false }],
    ['a reason but no flag', { error_code: 'X', error_msg: 'y' }],
    ['null flag', { is_success: null, error_msg: 'y' }],
    ['empty flag', { is_success: '', error_code: 'X', error_msg: 'y' }],
    ['zero flag', { is_success: 0, error_code: 'X', error_msg: 'y' }],
    ['"no" flag', { is_success: 'no', error_code: 'X', error_msg: 'y' }],
    ['failure flag, an EMPTY order list is still a list', { is_success: false, order_list: [null], error_code: 'X' }],
    ['a number', 42],
  ]) {
    businessAnswer = async () => answerValue;
    await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === false && !err.aliCode, name);
  }

  // a gateway code that means "turned away before any order logic ran" is certain; any other code is not (a remote-service error can come
  // back AFTER the order was created)
  for (const code of ['InvalidSession', 'IncompleteSignature', 'MissingParameter', 'AppApiCallLimit', 'InsufficientPermission', 'IllegalAccessToken']) {
    businessAnswer = async () => { throw Object.assign(new Error('x'), { aliCode: code }); };
    await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected === true, code);
  }
  for (const code of ['15', 'ServiceUnavailable', 'InternalError', 'SomethingNew', '0']) {
    businessAnswer = async () => { throw Object.assign(new Error('x'), { aliCode: code }); };
    await assert.rejects(() => adapter.createOrder('u1', ORDER), (err) => err.rejected !== true, code);
  }

  // never connected: nothing was sent -> a refusal, and AliExpress was not called
  business.length = 0;
  await assert.rejects(() => adapter.createOrder('nobody', ORDER), (err) => err.rejected === true && /not connected/.test(err.message));
  assert.strictEqual(business.length, 0);
  await assert.rejects(() => adapter.createOrder('u1', { items: [], address: ADDRESS }), (err) => err.rejected === true);
  assert.strictEqual(business.length, 0);

  // ---------- payOrder (aliexpress.ds.order.afterpay): req = {"order_id": ...}; the answer is a boolean ----------
  business.length = 0;
  businessAnswer = async () => true;
  assert.deepStrictEqual(await adapter.payOrder('u1', 1000000000), { paid: true, message: null });
  assert.strictEqual(business[0].method, 'aliexpress.ds.order.afterpay');
  assert.deepStrictEqual(JSON.parse(business[0].params.req), { order_id: '1000000000' });
  businessAnswer = async () => 'true';
  assert.strictEqual((await adapter.payOrder('u1', '5')).paid, true);
  businessAnswer = async () => false;
  assert.deepStrictEqual(await adapter.payOrder('u1', '5'), { paid: false, message: null });
  businessAnswer = async () => ({ rsp_code: '123', rsp_msg: 'Insufficient balance' });
  assert.deepStrictEqual(await adapter.payOrder('u1', '5'), { paid: false, message: 'Insufficient balance' });
  businessAnswer = async () => ({ success: false, msg: 'Order closed' });
  assert.deepStrictEqual(await adapter.payOrder('u1', '5'), { paid: false, message: 'Order closed' }, 'an explicit false flag is a stated no');
  businessAnswer = async () => ({ is_success: 'false' });
  assert.deepStrictEqual(await adapter.payOrder('u1', '5'), { paid: false, message: null });
  // a response code that says the SYSTEM failed is not a decline either (the payment may still be processing): unclear, so the claim is kept
  for (const rspCode of ['500', '502', '503', 'SYSTEM_ERROR', 'TIMEOUT', 'time_out', 'INTERNAL_ERROR', 'SERVICE_BUSY', 'UNKNOWN', 'service unavailable', 'RETRY_LATER']) {
    businessAnswer = async () => ({ rsp_code: rspCode, rsp_msg: 'Something went wrong' });
    await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected === false && !err.aliCode, rspCode);
  }
  businessAnswer = async () => ({ rsp_code: 'PAYMENT_DECLINED', rsp_msg: 'Card declined' });
  assert.deepStrictEqual(await adapter.payOrder('u1', '5'), { paid: false, message: 'Card declined' }, 'a stated decline is still a decline');
  // a message alone proves nothing, and success-shaped objects carry messages too: NOT a "no" (that would release the claim and invite a second payment)
  for (const successShaped of [{ rsp_code: '200', rsp_msg: 'success' }, { rsp_code: '0', rsp_msg: 'ok' }, { success: true, msg: 'ok' }, { is_success: 'true', msg: 'paid' }, { msg: 'Payment request received' }, { rsp_msg: 'Insufficient balance' }, { success: true, rsp_code: '500', rsp_msg: 'weird' }]) {
    businessAnswer = async () => successShaped;
    await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected === false && !err.aliCode, JSON.stringify(successShaped));
  }
  // nothing in the answer says whether the payment happened -> NOT a "no" (it may have gone through), and never "paid"
  for (const unreadable of [null, undefined, {}, [], 'weird', 42, { request_id: 'x' }]) {
    businessAnswer = async () => unreadable;
    await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected === false && !err.aliCode, JSON.stringify(unreadable));
  }
  // turned away before any payment logic ran = certain; any other failure (timeout, other gateway code) is unclear
  businessAnswer = async () => { throw Object.assign(new Error('x'), { aliCode: 'InvalidSession' }); };
  await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected === true);
  businessAnswer = async () => { throw Object.assign(new Error('x'), { aliCode: '15' }); };
  await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected !== true);
  businessAnswer = async () => { throw new Error('Could not reach AliExpress: timeout'); };
  await assert.rejects(() => adapter.payOrder('u1', '5'), (err) => err.rejected !== true);
  business.length = 0;
  await assert.rejects(() => adapter.payOrder('nobody', '5'), (err) => err.rejected === true && /not connected/.test(err.message));
  assert.strictEqual(business.length, 0, 'not connected: AliExpress is not called');

  // ---------- getOrderDetail (aliexpress.trade.ds.order.get): AliExpress's own sample answer ----------
  business.length = 0;
  businessAnswer = async () => ({
    gmt_create: '2018-08-28 05:39:01', order_status: 'FUND_PROCESSING',
    logistics_info_list: [{ logistics_service: 'EMS', logistics_no: 'CP0_318495001' }],
    pay_timeout_second: '86400', user_order_amount: { amount: '199.00', currency_code: 'USD' },
    order_paidtime_string: '2019-06-03T18:05:47-07:00[America/Los_Angeles]', order_amount: { amount: '199.00', currency_code: 'USD' },
    child_order_list: [{ product_count: '3', sku_id: '12345', product_id: '2100000012', end_reason: 'CANCELED' }],
    logistics_status: 'SELLER_SEND_GOODS',
  });
  const detail = await adapter.getOrderDetail('u1', 1000000000);
  assert.strictEqual(business[0].method, 'aliexpress.trade.ds.order.get');
  assert.deepStrictEqual(JSON.parse(business[0].params.single_order_query), { order_id: '1000000000' });
  assert.deepStrictEqual(detail, {
    status: 'FUND_PROCESSING', logisticsStatus: 'SELLER_SEND_GOODS', amount: 199, currency: 'USD', paidAt: '2019-06-03T18:05:47-07:00[America/Los_Angeles]',
    createdAt: '2018-08-28 05:39:01', payTimeoutSeconds: 86400,
    logistics: [{ service: 'EMS', number: 'CP0_318495001' }],
    lines: [{ productId: '2100000012', skuId: '12345', quantity: 3, endReason: 'CANCELED' }],
  });
  businessAnswer = async () => ({ order_status: 'PLACE_ORDER_SUCCESS' });
  const bare = await adapter.getOrderDetail('u1', 1);
  assert.deepStrictEqual([bare.status, bare.amount, bare.currency, bare.paidAt, bare.logistics, bare.lines], ['PLACE_ORDER_SUCCESS', null, null, null, [], []], 'unknown stays null - never 0');
  businessAnswer = async () => null;
  assert.strictEqual(await adapter.getOrderDetail('u1', 1), null);

  // ---------- getOrderTracking (aliexpress.ds.order.tracking.get): AliExpress's own sample answer ----------
  business.length = 0;
  businessAnswer = async () => ({
    ret: 'true', msg: 'error message', code: 'error code',
    data: { tracking_detail_line_list: [{
      detail_node_list: [{ time_stamp: '1720181940000', tracking_detail_desc: 'Package delivered', tracking_name: 'Delivery update' }, { time_stamp: '1720100000000', tracking_detail_desc: 'Shipped', tracking_name: 'Shipped' }],
      cp_name: 'YunExpress', cp_website_url: 'https://www.yunexpress.com/', carrier_name: 'AliExpress Selection Standard', mail_no: '62727952231', eta_time_stamps: '1720514236934',
      package_item_list: [{ quantity: '1', item_id: '1005005511268056' }],
    }] },
  });
  const tracking = await adapter.getOrderTracking('u1', '1000000000');
  assert.strictEqual(business[0].method, 'aliexpress.ds.order.tracking.get');
  assert.deepStrictEqual(business[0].params, { ae_order_id: '1000000000', language: 'en_US' });
  assert.deepStrictEqual(tracking, [{ trackingNumber: '62727952231', carrier: 'AliExpress Selection Standard', etaMs: 1720514236934, lastEvent: 'Package delivered' }], 'the newest event, the carrier name, the tracking number');
  businessAnswer = async () => ({ result: { data: { tracking_detail_line_list: [{ cp_name: 'YunExpress', mail_no: 'ABC1' }] } } });
  assert.deepStrictEqual(await adapter.getOrderTracking('u1', '1'), [{ trackingNumber: 'ABC1', carrier: 'YunExpress', etaMs: null, lastEvent: null }], 'the carrier falls back to cp_name; the answer one level deeper is read too');
  for (const none of [null, {}, { ret: 'false', code: 'TRACKING DATA NOT FOUND' }, { data: { tracking_detail_line_list: [] } }, { data: { tracking_detail_line_list: [{ carrier_name: 'X' }] } }]) {
    businessAnswer = async () => none;
    assert.deepStrictEqual(await adapter.getOrderTracking('u1', '1'), [], 'no shipment yet: an empty list, not an error: ' + JSON.stringify(none));
  }

  console.log('aliexpress order adapter tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
