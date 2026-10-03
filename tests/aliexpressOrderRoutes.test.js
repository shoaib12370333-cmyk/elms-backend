// routes/aliexpressOrders.js: the status codes for each outcome of services/aliexpressOrderService.js, that only a real `true` counts
// as a confirmation (allowLoss / confirmNotPlaced / pay's confirm), that a bad id never reaches the service, and that a crash tells the
// seller to check AliExpress rather than pretend nothing happened. The real router runs; the service and auth are stand-ins.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
const seen = [];
let answer = {};
const svc = {};
for (const name of ['previewOrder', 'placeOrder', 'payOrder', 'refreshOrder', 'releaseOrder']) svc[name] = async (...args) => { seen.push([name, ...args]); if (answer instanceof Error) throw answer; return answer; };
stub('services/aliexpressOrderService', svc);
const router = require('../routes/aliexpressOrders');

const handler = (p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods.post); assert.ok(l, 'route ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (p, { params = { orderId: 'a'.repeat(24) }, body = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler(p)({ userId: 'u1', params, body }, res);
  return out;
};
const ID = 'a'.repeat(24);

(async () => {
  // ---------- a bad id never reaches the service ----------
  for (const p of ['/:orderId/preview', '/:orderId/place', '/:orderId/pay', '/:orderId/refresh', '/:orderId/release']) {
    seen.length = 0;
    const out = await call(p, { params: { orderId: 'not-an-id' } });
    assert.strictEqual(out.status, 404, p);
    assert.strictEqual(seen.length, 0, p);
  }

  // ---------- preview ----------
  answer = { orderId: ID, canPlace: true, blockers: [] };
  let out = await call('/:orderId/preview', { body: { address: { zip: 'X' } } });
  assert.deepStrictEqual([out.status, out.body.success, out.body.preview.canPlace], [200, true, true]);
  assert.deepStrictEqual(seen[seen.length - 1], ['previewOrder', 'u1', ID, { address: { zip: 'X' } }]);
  answer = { error: 'not_found' };
  assert.strictEqual((await call('/:orderId/preview')).status, 404);

  // ---------- place: every outcome has its own status and keeps its code ----------
  answer = { order: { id: ID }, preview: { cost: { total: 12.5 } } };
  out = await call('/:orderId/place', { body: { address: { zip: 'X' } } });
  assert.deepStrictEqual([out.status, out.body.success, out.body.order.id], [200, true, ID]);
  for (const [error, status] of [['blocked', 409], ['claimed', 409], ['refused', 422], ['unknown', 502]]) {
    answer = { error, message: 'Because of ' + error, blockers: [{ code: 'x' }], preview: { p: 1 } };
    out = await call('/:orderId/place');
    assert.strictEqual(out.status, status, error);
    assert.deepStrictEqual([out.body.success, out.body.error, out.body.code], [false, 'Because of ' + error, error]);
  }
  assert.deepStrictEqual(out.body.blockers, [{ code: 'x' }]);
  answer = { error: 'not_found' };
  out = await call('/:orderId/place');
  assert.deepStrictEqual([out.status, out.body.error], [404, 'Order not found.']);

  // only a real `true` accepts a loss / a possibly-existing order (a string "true", 1, "yes" do not)
  answer = { order: {} };
  for (const [val, expected] of [[true, true], ['true', false], [1, false], ['yes', false], [undefined, false], [false, false]]) {
    seen.length = 0;
    await call('/:orderId/place', { body: { allowLoss: val, confirmNotPlaced: val } });
    assert.deepStrictEqual([seen[0][3].allowLoss, seen[0][3].confirmNotPlaced], [expected, expected], JSON.stringify(val));
  }

  // the blockers the seller was shown and ticked are passed on as a list of strings - nothing else
  answer = { order: {} };
  for (const [val, expected] of [[['already_ordered', 'unknown_state'], ['already_ordered', 'unknown_state']], [['a', 5, null, {}, 'b'], ['a', 'b']], ['already_ordered', []], [undefined, []], [null, []], [{ 0: 'a' }, []]]) {
    seen.length = 0;
    await call('/:orderId/place', { body: { shownCodes: val } });
    assert.deepStrictEqual(seen[0][3].shownCodes, expected, JSON.stringify(val));
  }

  // ---------- pay ----------
  answer = { order: { id: ID }, alreadyPaid: true };
  out = await call('/:orderId/pay', { body: { confirm: true, expectedAmount: 12.5, expectedCurrency: 'USD' } });
  assert.deepStrictEqual([out.status, out.body.success, out.body.alreadyPaid], [200, true, true]);
  assert.deepStrictEqual(seen[seen.length - 1], ['payOrder', 'u1', ID, { confirm: true, expectedAmount: 12.5, expectedCurrency: 'USD' }], 'the amount AND currency the seller saw go to the service');
  for (const bad of ['true', 1, 'yes', undefined, null]) {
    seen.length = 0;
    answer = { order: {} };
    await call('/:orderId/pay', { body: { confirm: bad, expectedAmount: 12.5 } });
    assert.strictEqual(seen[0][3].confirm, false, 'confirm must be exactly true: ' + JSON.stringify(bad));
  }
  seen.length = 0; answer = { order: {} };
  await call('/:orderId/pay', { body: undefined });
  assert.strictEqual(seen[0][3].confirm, false, 'no body: not confirmed');
  answer = { error: 'amount_changed', message: 'AliExpress now asks for 14.90 USD', amount: 14.9, currency: 'USD' };
  out = await call('/:orderId/pay', { body: { confirm: true, expectedAmount: 12.5 } });
  assert.deepStrictEqual([out.status, out.body.code, out.body.amount, out.body.currency], [409, 'amount_changed', 14.9, 'USD'], 'the new amount comes back so the window can show it');
  for (const [error, status] of [['confirm', 400], ['not_placed', 409], ['no_amount', 409], ['not_accepted', 422], ['multiple', 409], ['cancelled', 409], ['not_paid', 409], ['claimed', 409], ['pay_unclear', 502], ['shipped', 409], ['not_payable', 409], ['wrong_item', 409], ['changed', 409]]) {
    answer = { error, message: 'm' };
    assert.strictEqual((await call('/:orderId/pay', { body: { confirm: true } })).status, status, error);
  }

  // a payment AliExpress accepted but does not show yet comes back as 200 with pending + the message
  answer = { order: { id: ID }, pending: true, message: 'AliExpress accepted the payment but does not show the order as paid yet.' };
  out = await call('/:orderId/pay', { body: { confirm: true, expectedAmount: 12.5, expectedCurrency: 'USD' } });
  assert.deepStrictEqual([out.status, out.body.success, out.body.pending, /does not show the order as paid yet/.test(out.body.message)], [200, true, true, true]);
  answer = { order: { id: ID } };
  out = await call('/:orderId/pay', { body: { confirm: true, expectedAmount: 12.5, expectedCurrency: 'USD' } });
  assert.deepStrictEqual([out.body.pending, out.body.message], [false, null]);

  // ---------- refresh ----------
  answer = { order: { id: ID } };
  out = await call('/:orderId/refresh');
  assert.deepStrictEqual([out.status, out.body.success], [200, true]);
  answer = { error: 'not_placed', message: 'No AliExpress order was placed for this line.' };
  out = await call('/:orderId/refresh');
  assert.deepStrictEqual([out.status, out.body.code], [409, 'not_placed']);

  // ---------- release: only a real true, and its own outcomes ----------
  for (const bad of ['true', 1, 'yes', undefined, null]) {
    seen.length = 0; answer = { order: {} };
    await call('/:orderId/release', { body: { confirm: bad } });
    assert.strictEqual(seen[0][3].confirm, false, 'confirm must be exactly true: ' + JSON.stringify(bad));
  }
  seen.length = 0; answer = { order: { id: ID } };
  out = await call('/:orderId/release', { body: { confirm: true } });
  assert.deepStrictEqual([out.status, out.body.success, out.body.order.id, seen[0][0], seen[0][3]], [200, true, ID, 'releaseOrder', { confirm: true }]);
  for (const [error, status] of [['confirm', 400], ['not_placed', 409], ['shipped', 409], ['multiple', 409], ['release_blocked', 409], ['changed', 409]]) {
    answer = { error, message: 'm' };
    assert.strictEqual((await call('/:orderId/release', { body: { confirm: true } })).status, status, error);
  }
  answer = { error: 'not_found' };
  assert.deepStrictEqual((({ status, body }) => [status, body.error])(await call('/:orderId/release', { body: { confirm: true } })), [404, 'Order not found.']);

  // ---------- a failure AFTER the order / payment was sent: the seller is told exactly that ----------
  answer = Object.assign(new Error('The AliExpress order 5001 WAS created, but ELMS could not save it. Do not order again - find it in your AliExpress orders.'), { irreversible: true });
  out = await call('/:orderId/place');
  assert.deepStrictEqual([out.status, out.body.code, out.body.error], [500, 'saved_late', answer.message]);

  // ---------- a crash: the seller is told to check AliExpress, not that "nothing happened" ----------
  answer = new Error('boom with secrets');
  out = await call('/:orderId/place');
  assert.strictEqual(out.status, 500);
  assert.match(out.body.error, /check your AliExpress orders/i);
  assert.ok(!/secrets/.test(JSON.stringify(out.body)), 'the internal message is not shown');

  console.log('aliexpress order routes tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
