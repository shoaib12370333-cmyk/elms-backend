// order-sync-extension/background.js run against a fake chrome and a fake ELMS: the tab <-> ELMS-order association
// lives in chrome.storage.session (survives a service-worker restart, unlike a plain variable), is set only when the
// content script sees an "elms_order" link parameter, read back once on the confirmation page, and cleared once used
// or when the tab closes. An expired session is renewed once, same as the other extensions' background scripts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'order-sync-extension', 'background.js'), 'utf8');

function boot({ stored = {}, session = {}, respond }) {
  const store = { extensionKey: 'key-1', sessionToken: 'old-token', ...stored };
  const sessionStore = { ...session };
  const fetches = [];
  const listeners = { message: null, tabRemoved: null };
  const chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => store[k] !== undefined).map((k) => [k, store[k]])),
        set: async (obj) => Object.assign(store, obj),
      },
      session: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => sessionStore[k] !== undefined).map((k) => [k, sessionStore[k]])),
        set: async (obj) => Object.assign(sessionStore, obj),
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete sessionStore[k]; },
      },
    },
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } },
    tabs: { onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } } },
  };
  const fakeFetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', auth: (opts.headers || {}).Authorization || null, body: opts.body ? JSON.parse(opts.body) : null };
    fetches.push(call);
    const out = await respond(call);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  const context = vm.createContext({ chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Date, URL, JSON, Promise, Error, Object, Number, String, Array, console });
  vm.runInContext(code, context);
  const message = (m, sender = { tab: { id: 1 } }) => new Promise((resolve) => { const keep = listeners.message(m, sender, resolve); assert.strictEqual(keep, true, 'the answer comes later'); });
  return { store, sessionStore, fetches, listeners, message };
}

const SETTINGS = { status: 200, body: { success: true, backendUrl: 'https://api.example.test' } };
const EXCHANGE = { status: 200, body: { success: true, sessionToken: 'fresh-token' } };

(async () => {
  // ---------- remembering, reading and forgetting a tab's order, all keyed by tab id ----------
  let env = boot({ respond: () => SETTINGS });
  let r = await env.message({ type: 'ELMS_REMEMBER_TAB_ORDER', orderId: 'o1' }, { tab: { id: 7 } });
  assert.strictEqual(r.success, true);
  r = await env.message({ type: 'ELMS_GET_TAB_ORDER' }, { tab: { id: 7 } });
  assert.strictEqual(r.result, 'o1');
  r = await env.message({ type: 'ELMS_GET_TAB_ORDER' }, { tab: { id: 8 } });
  assert.strictEqual(r.result, null, 'a different tab never sees another tab\'s order');
  r = await env.message({ type: 'ELMS_FORGET_TAB_ORDER' }, { tab: { id: 7 } });
  assert.strictEqual(r.success, true);
  r = await env.message({ type: 'ELMS_GET_TAB_ORDER' }, { tab: { id: 7 } });
  assert.strictEqual(r.result, null, 'forgotten');

  // ---------- a message with no sender.tab.id (should never happen, but never throws) ----------
  r = await env.message({ type: 'ELMS_REMEMBER_TAB_ORDER', orderId: 'o1' }, {});
  assert.strictEqual(r.result, false);
  r = await env.message({ type: 'ELMS_GET_TAB_ORDER' }, {});
  assert.strictEqual(r.result, null);

  // ---------- a closed tab is forgotten automatically ----------
  env = boot({ session: { tab_order_9: 'o9' }, respond: () => SETTINGS });
  await env.listeners.tabRemoved(9);
  r = await env.message({ type: 'ELMS_GET_TAB_ORDER' }, { tab: { id: 9 } });
  assert.strictEqual(r.result, null);

  // ---------- ELMS_MARK_ORDERED: the right endpoint, method, body and auth ----------
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : { status: 200, body: { success: true, order: { id: 'o1', fulfillment_status: 'ordered_from_amazon' } } }) });
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o1', deliveryDate: '2026-10-05', buyingPrice: 42.5 });
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.result, { id: 'o1', fulfillment_status: 'ordered_from_amazon' }, 'unwraps to just the order');
  const call = env.fetches.find((c) => c.url.endsWith('/api/orders/o1/ordered'));
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.auth, 'Bearer old-token');
  assert.deepStrictEqual(call.body, { ordered: true, deliveryDate: '2026-10-05', buyingPrice: 42.5 });

  // ---------- no delivery date read: still saves the buying cost, with a null date rather than omitting the field ----------
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o2', deliveryDate: null, buyingPrice: 10 });
  const call2 = env.fetches.find((c) => c.url.endsWith('/api/orders/o2/ordered'));
  assert.deepStrictEqual(call2.body, { ordered: true, deliveryDate: null, buyingPrice: 10 });

  // ---------- an order id with characters that need escaping in a URL path ----------
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o/1?2', deliveryDate: null, buyingPrice: 1 });
  assert.ok(env.fetches.some((c) => c.url.endsWith('/api/orders/o%2F1%3F2/ordered')));

  // ---------- an expired session is renewed from the Extension Key, once ----------
  let seen = 0;
  env = boot({ respond: (c) => {
    if (c.url.endsWith('/extension-settings')) return SETTINGS;
    if (c.url.endsWith('/extension-key/exchange')) return EXCHANGE;
    seen += 1;
    return c.auth === 'Bearer fresh-token' ? { status: 200, body: { success: true, order: { id: 'o1' } } } : { status: 401, body: { success: false, error: 'expired' } };
  } });
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o1', deliveryDate: null, buyingPrice: 1 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(seen, 2, 'one refused call, one that worked');
  assert.strictEqual(env.store.sessionToken, 'fresh-token');

  // ---------- ELMS cannot be reached ----------
  env = boot({ respond: (c) => { if (c.url.endsWith('/extension-settings')) return SETTINGS; throw new TypeError('Failed to fetch'); } });
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o1', deliveryDate: null, buyingPrice: 1 });
  assert.strictEqual(r.success, false);
  assert.ok(/waking up/.test(r.error), r.error);

  // ---------- not connected ----------
  env = boot({ stored: { extensionKey: '' }, respond: () => SETTINGS });
  r = await env.message({ type: 'ELMS_MARK_ORDERED', orderId: 'o1', deliveryDate: null, buyingPrice: 1 });
  assert.deepStrictEqual([r.success, r.error], [false, 'Connect your ELMS Extension Key first.']);

  // ---------- an unknown message type is not ours ----------
  env = boot({ respond: () => SETTINGS });
  assert.strictEqual(env.listeners.message({ type: 'SOMETHING_ELSE' }, {}, () => {}), false);

  console.log('order sync extension background tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
