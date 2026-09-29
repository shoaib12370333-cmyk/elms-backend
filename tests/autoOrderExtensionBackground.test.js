// The Auto Order extension's background script (auto-order-extension/background.js), run against a fake chrome and a
// fake ELMS, the same vm-sandbox style as tests/extensionBackground.test.js for the existing import extension: one
// job at a time, a stale job is abandoned before a new one starts, and - the one that matters most, since a real
// purchase is one click away - AO_CHECKS re-validates the order total against the cap itself rather than trusting
// whatever the content script says.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'auto-order-extension', 'background.js'), 'utf8');

function boot({ stored = {}, respond } = {}) {
  const store = { extensionKey: 'key-1', sessionToken: 'old-token', autoOrderOn: true, paused: false, ...stored };
  const fetches = [];
  const listeners = { message: null, alarm: null, installed: null };
  const tabs = { created: [], removed: [] };
  let nextTabId = 100;
  const chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => store[k] !== undefined).map((k) => [k, store[k]])),
      set: async (obj) => Object.assign(store, obj),
      remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]),
    } },
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } }, onInstalled: { addListener: (fn) => { listeners.installed = fn; } } },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => { listeners.alarm = fn; } } },
    tabs: {
      create: async (o) => { const id = nextTabId++; tabs.created.push({ id, url: o.url, active: !!o.active }); return { id }; },
      remove: async (id) => { tabs.removed.push(id); },
    },
  };
  const fakeFetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', auth: (opts.headers || {}).Authorization || null, body: opts.body ? JSON.parse(opts.body) : null };
    fetches.push(call);
    const out = await respond(call);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  const context = vm.createContext({ chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Date, URL, JSON, Promise, Error, Object, Number, String, Array, Math, console });
  vm.runInContext(code, context);
  const message = (m, sender = {}) => new Promise((resolve) => { const keep = listeners.message(m, sender, resolve); assert.strictEqual(keep, true, 'the answer comes later'); });
  return { store, fetches, tabs, listeners, message };
}

const SETTINGS = { status: 200, body: { success: true, backendUrl: 'https://api.example.test' } };
const order = (over = {}) => ({ id: 'so1', ebay_order_id: 'E1', amazon_url: 'https://www.amazon.com/dp/B0TEST0001', max_allowed_cost: 25, quantity: 1, ...over });

(async () => {
  // ---------- AO_GET_STATE: sane defaults before anything has happened ----------
  let env = boot({ stored: { autoOrderOn: false } });
  let r = await env.message({ type: 'AO_GET_STATE' });
  assert.deepStrictEqual([r.autoOrderOn, r.paused, r.active], [false, false, null]);

  // ---------- AO_SET_ON: turning it on immediately ticks - claims the next order, opens a background tab ----------
  env = boot({ stored: { autoOrderOn: false }, respond: (c) => {
    if (c.url.endsWith('/extension-settings')) return SETTINGS;
    if (c.url.endsWith('/auto-order/next')) return { status: 200, body: { success: true, order: order(), settings: { primeOnly: true } } };
    return { status: 200, body: { success: true } };
  } });
  r = await env.message({ type: 'AO_SET_ON', on: true });
  assert.strictEqual(r.ok, true);
  await new Promise((res) => setTimeout(res, 0)); // let the un-awaited tick() inside AO_SET_ON settle
  assert.strictEqual(env.tabs.created.length, 1);
  assert.strictEqual(env.tabs.created[0].url, 'https://www.amazon.com/dp/B0TEST0001');
  let state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active.orderId, 'so1');
  assert.strictEqual(state.active.tabId, env.tabs.created[0].id);
  assert.strictEqual(state.active.step, 'loading');

  // ---------- one at a time: a second alarm tick, while a job is still active and fresh, never claims another ----------
  const before = env.fetches.filter((c) => c.url.endsWith('/auto-order/next')).length;
  await env.listeners.alarm({ name: 'auto-order-poll' });
  assert.strictEqual(env.fetches.filter((c) => c.url.endsWith('/auto-order/next')).length, before, 'no second /next call while a job is in flight');

  // ---------- AO_ANNOUNCE: only the tab actually holding the job gets it back ----------
  const activeTabId = env.tabs.created[0].id;
  r = await env.message({ type: 'AO_ANNOUNCE' }, { tab: { id: activeTabId } });
  assert.strictEqual(r.job.order.id, 'so1');
  r = await env.message({ type: 'AO_ANNOUNCE' }, { tab: { id: activeTabId + 999 } });
  assert.strictEqual(r.job, null, 'a different Amazon tab the seller has open is left alone');

  // ---------- AO_STEP updates the step, only from the job's own tab ----------
  r = await env.message({ type: 'AO_STEP', step: 'product_checked' }, { tab: { id: activeTabId } });
  assert.strictEqual(r.ok, true);
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active.step, 'product_checked');

  // ---------- AO_CHECKS: the real safety gate - re-validated here, not trusted from the page ----------
  r = await env.message({ type: 'AO_CHECKS', inStock: false, total: 20 }, { tab: { id: activeTabId } });
  assert.strictEqual(r.pass, false);
  assert.match(r.reason, /out of stock/);

  r = await env.message({ type: 'AO_CHECKS', inStock: true, fulfilledByAmazon: true, total: 999 }, { tab: { id: activeTabId } });
  assert.strictEqual(r.pass, false, 'over the $25 cap');
  assert.match(r.reason, /over the allowed limit/);

  r = await env.message({ type: 'AO_CHECKS', inStock: true, fulfilledByAmazon: true, total: 'not a number' }, { tab: { id: activeTabId } });
  assert.strictEqual(r.pass, false, 'an unreadable total is never assumed safe');

  r = await env.message({ type: 'AO_CHECKS', inStock: true, fulfilledByAmazon: false, total: 20 }, { tab: { id: activeTabId } });
  assert.strictEqual(r.pass, false, 'primeOnly is on and this is not fulfilled by Amazon');
  assert.match(r.reason, /only allows those/);

  r = await env.message({ type: 'AO_CHECKS', inStock: true, fulfilledByAmazon: true, total: 20 }, { tab: { id: activeTabId } });
  assert.strictEqual(r.pass, true, 'in stock, fulfilled by Amazon, and $20 is within the $25 cap');
  assert.ok(env.fetches.find((c) => c.url.endsWith('/so1/placing')), 'ELMS is told this order is about to be placed');
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active.step, 'placing');

  // ---------- AO_PLACED: reports to ELMS (including the delivery date the content script read), closes the tab,
  // clears the active job, and it is recorded ----------
  r = await env.message({ type: 'AO_PLACED', amazonOrderId: 'AMZ-1', amazonTotal: 20, deliveryDate: '2026-10-05T00:00:00.000Z' }, { tab: { id: activeTabId } });
  assert.strictEqual(r.ok, true);
  const placedCall = env.fetches.find((c) => c.url.endsWith('/so1/placed'));
  assert.deepStrictEqual(placedCall.body, { amazonOrderId: 'AMZ-1', amazonTotal: 20, deliveryDate: '2026-10-05T00:00:00.000Z' });
  assert.deepStrictEqual(env.tabs.removed, [activeTabId]);
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active, null);
  assert.strictEqual(state.history[0].placed, true);
  assert.strictEqual(state.history[0].amazonOrderId, 'AMZ-1');

  // ---------- AO_BLOCKED: a captcha/signin/etc - reported as needs_attention, tab closed, never retried by itself ----------
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so2' }), settings: {} } } : { status: 200, body: { success: true } }) });
  await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  let tabId = env.tabs.created[0].id;
  r = await env.message({ type: 'AO_BLOCKED', reason: 'Amazon showed a captcha.' }, { tab: { id: tabId } });
  assert.strictEqual(r.ok, true);
  const failedCall = env.fetches.find((c) => c.url.endsWith('/so2/failed'));
  assert.deepStrictEqual(failedCall.body, { reason: 'Amazon showed a captcha.', needsAttention: true });
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active, null);
  assert.strictEqual(state.history[0].blocked, true);

  // ---------- AO_ERROR: an unexpected failure - needsAttention: false ----------
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so3' }), settings: {} } } : { status: 200, body: { success: true } }) });
  await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  tabId = env.tabs.created[0].id;
  await env.message({ type: 'AO_ERROR', reason: 'Something threw.' }, { tab: { id: tabId } });
  const errFailedCall = env.fetches.find((c) => c.url.endsWith('/so3/failed'));
  assert.deepStrictEqual(errFailedCall.body, { reason: 'Something threw.', needsAttention: false });

  // ---------- an unsupported Amazon site, or no safe cap: refused before a tab is even opened ----------
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so4', amazon_url: 'https://www.amazon.co.jp/dp/B0TEST0001' }), settings: {} } } : { status: 200, body: { success: true } }) });
  await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  assert.strictEqual(env.tabs.created.length, 0, 'amazon.co.jp is not a supported site: no tab opened');
  assert.ok(env.fetches.find((c) => c.url.endsWith('/so4/failed')));

  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so5', max_allowed_cost: null }), settings: {} } } : { status: 200, body: { success: true } }) });
  await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  assert.strictEqual(env.tabs.created.length, 0, 'no safe price cap: refused rather than guessed');

  // ---------- AO_STOP_NOW: the seller's own stop button abandons whatever is active right now ----------
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so6' }), settings: {} } } : { status: 200, body: { success: true } }) });
  await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  r = await env.message({ type: 'AO_STOP_NOW' });
  assert.strictEqual(r.ok, true);
  assert.ok(env.fetches.find((c) => c.url.endsWith('/so6/failed') && c.body.reason === 'Stopped by the seller.'));
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active, null);

  // ---------- manual mode: the tab opens in the foreground, and a step waits for an explicit approval ----------
  env = boot({ stored: { autoOrderOn: false }, respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: order({ id: 'so7' }), settings: {} } } : { status: 200, body: { success: true } }) });
  r = await env.message({ type: 'AO_SET_MANUAL', manual: true });
  assert.strictEqual(r.ok, true);
  r = await env.message({ type: 'AO_SET_ON', on: true });
  await new Promise((res) => setTimeout(res, 0));
  assert.strictEqual(env.tabs.created[0].active, true, 'manual mode: the tab is not hidden');
  const manualTabId = env.tabs.created[0].id;

  // the content script asks to click "Buy Now" - not yet approved, so it must wait
  r = await env.message({ type: 'AO_AWAIT_STEP', name: 'click_buy_now', description: 'Click "Buy Now"' }, { tab: { id: manualTabId } });
  assert.strictEqual(r.proceed, false);
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active.pendingStep.name, 'click_buy_now');
  assert.strictEqual(state.active.pendingStep.description, 'Click "Buy Now"');

  // asking again before the seller does anything: still not approved
  r = await env.message({ type: 'AO_AWAIT_STEP', name: 'click_buy_now', description: 'Click "Buy Now"' }, { tab: { id: manualTabId } });
  assert.strictEqual(r.proceed, false);

  // the seller presses "Do it" in the popup
  r = await env.message({ type: 'AO_APPROVE_STEP' });
  assert.strictEqual(r.ok, true);

  // now the same step name is allowed through, exactly once, and the pending/approved flags are cleared after
  r = await env.message({ type: 'AO_AWAIT_STEP', name: 'click_buy_now', description: 'Click "Buy Now"' }, { tab: { id: manualTabId } });
  assert.strictEqual(r.proceed, true);
  state = await env.message({ type: 'AO_GET_STATE' });
  assert.strictEqual(state.active.pendingStep, null);

  // a later, different step needs its own separate approval - the earlier approval does not carry over
  r = await env.message({ type: 'AO_AWAIT_STEP', name: 'click_place_order', description: 'Click "Place your order"' }, { tab: { id: manualTabId } });
  assert.strictEqual(r.proceed, false);

  // stopping the job mid-wait: the next poll reports "stopped" instead of hanging forever
  await env.message({ type: 'AO_STOP_NOW' });
  r = await env.message({ type: 'AO_AWAIT_STEP', name: 'click_place_order', description: 'x' }, { tab: { id: manualTabId } });
  assert.strictEqual(r.stopped, true);

  // ---------- paused: the alarm never even asks for a next order ----------
  env = boot({ stored: { paused: true }, respond: () => { throw new Error('must not be called while paused'); } });
  await env.listeners.alarm({ name: 'auto-order-poll' });
  await env.listeners.alarm({ name: 'not-ours' });
  assert.strictEqual(env.fetches.length, 0);

  // ---------- a stale job (the tab never reported back) is abandoned before the next poll starts a fresh one ----------
  env = boot({
    stored: { active: { orderId: 'stuck1', tabId: 555, order: order({ id: 'stuck1' }), settings: {}, step: 'loading', startedAt: Date.now() - 20 * 60 * 1000 } },
    respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/auto-order/next') ? { status: 200, body: { success: true, order: null } } : { status: 200, body: { success: true } }),
  });
  await env.listeners.alarm({ name: 'auto-order-poll' });
  assert.ok(env.fetches.find((c) => c.url.endsWith('/stuck1/failed')), 'the stale job is failed');
  assert.deepStrictEqual(env.tabs.removed, [555]);

  console.log('auto-order extension background tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
