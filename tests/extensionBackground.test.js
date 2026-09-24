// The extension's background script (extension/background.js) run against a fake chrome and a fake ELMS: an expired session is
// renewed once, errors keep their message and code, the backend address is asked for only now and then, only ELMS pages are opened.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

function boot({ stored = {}, respond }) {
  const store = { extensionKey: 'key-1', sessionToken: 'old-token', ...stored };
  const fetches = [];
  const listeners = { message: null, command: null };
  const tabs = { created: [], sent: [] };
  const chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => store[k] !== undefined).map((k) => [k, store[k]])),
      set: async (obj) => Object.assign(store, obj),
    } },
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } },
    commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
    tabs: {
      create: async (o) => { tabs.created.push(o.url); },
      query: async () => [{ id: 7 }],
      sendMessage: async (id, m) => { tabs.sent.push([id, m.type]); },
    },
  };
  const fakeFetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', auth: (opts.headers || {}).Authorization || null, body: opts.body ? JSON.parse(opts.body) : null };
    fetches.push(call);
    const out = await respond(call);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  const context = vm.createContext({ chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Date, URL, JSON, Promise, Error, Object, Number, String, Array, console });
  vm.runInContext(code, context);
  const message = (m) => new Promise((resolve) => { const keep = listeners.message(m, {}, resolve); assert.strictEqual(keep, true, 'the answer comes later'); });
  return { store, fetches, tabs, listeners, message };
}

const SETTINGS = { status: 200, body: { success: true, backendUrl: 'https://api.example.test' } };
const EXCHANGE = { status: 200, body: { success: true, sessionToken: 'fresh-token' } };

(async () => {
  // ---- a normal call: the saved session is used, the backend address is asked for once ----
  let env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : { status: 200, body: { success: true, credits: { balance: 3 } } }) });
  let r = await env.message({ type: 'ELMS_CHECK', payload: { asin: 'B0TEST0001' } });
  assert.deepStrictEqual([r.success, r.result.credits.balance], [true, 3]);
  const check = env.fetches.find((c) => c.url.endsWith('/api/extension/check'));
  assert.strictEqual(check.url, 'https://api.example.test/api/extension/check');
  assert.strictEqual(check.method, 'POST');
  assert.strictEqual(check.auth, 'Bearer old-token');
  assert.deepStrictEqual(check.body, { asin: 'B0TEST0001' });
  assert.strictEqual(env.store.backend, 'https://api.example.test');
  await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.strictEqual(env.fetches.filter((c) => c.url.endsWith('/extension-settings')).length, 1, 'the backend address is not asked again within ten minutes');
  env.store.backendCheckedAt = Date.now() - 11 * 60 * 1000;
  await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.strictEqual(env.fetches.filter((c) => c.url.endsWith('/extension-settings')).length, 2, 'after ten minutes it is');

  // ---- an expired session is renewed from the Extension Key, once ----
  let seen = 0;
  env = boot({ respond: (c) => {
    if (c.url.endsWith('/extension-settings')) return SETTINGS;
    if (c.url.endsWith('/extension-key/exchange')) return EXCHANGE;
    seen += 1;
    return c.auth === 'Bearer fresh-token' ? { status: 200, body: { success: true, ok: true } } : { status: 401, body: { success: false, error: 'expired' } };
  } });
  r = await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.strictEqual(r.success, true);
  assert.strictEqual(seen, 2, 'one refused call, one that worked');
  assert.strictEqual(env.store.sessionToken, 'fresh-token', 'the new session is kept');
  assert.deepStrictEqual(env.fetches.find((c) => c.url.endsWith('/exchange')).body, { extensionKey: 'key-1' });

  // no session yet: it is made first
  env = boot({ stored: { sessionToken: undefined }, respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : c.url.endsWith('/exchange') ? EXCHANGE : { status: 200, body: { success: true } }) });
  r = await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.strictEqual(r.success, true);
  assert.strictEqual(env.fetches[env.fetches.length - 1].auth, 'Bearer fresh-token');

  // ---- the import carries the store and the markup ----
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : { status: 200, body: { success: true, draft: { id: 'D1' }, creditsLeft: 4 } }) });
  r = await env.message({ type: 'ELMS_IMPORT_PRODUCT', amazonUrl: 'https://www.amazon.co.uk/dp/B0TEST0001', product: { asin: 'B0TEST0001' }, markupPercent: 54, ebayAccountId: 'S1' });
  assert.strictEqual(r.result.creditsLeft, 4);
  const imp = env.fetches.find((c) => c.url.endsWith('/api/browser-import'));
  assert.deepStrictEqual(imp.body, { amazonUrl: 'https://www.amazon.co.uk/dp/B0TEST0001', product: { asin: 'B0TEST0001' }, markupPercent: 54, ebayAccountId: 'S1' });

  // ---- ELMS says no: the message and code come back ----
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : { status: 409, body: { success: false, code: 'already_listed', error: 'This product is already live on eBay in Trendy UK. Nothing was imported and no credit was used.' } }) });
  r = await env.message({ type: 'ELMS_IMPORT_PRODUCT', amazonUrl: 'u', product: {} });
  assert.deepStrictEqual([r.success, r.status, r.code], [false, 409, 'already_listed']);
  assert.ok(r.error.startsWith('This product is already live'));

  // ---- ELMS cannot be reached (a sleeping server) ----
  env = boot({ respond: (c) => { if (c.url.endsWith('/extension-settings')) return SETTINGS; throw new TypeError('Failed to fetch'); } });
  r = await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.strictEqual(r.success, false);
  assert.ok(/waking up/.test(r.error), r.error);

  // ---- not connected ----
  env = boot({ stored: { extensionKey: '' }, respond: () => SETTINGS });
  r = await env.message({ type: 'ELMS_CHECK', payload: {} });
  assert.deepStrictEqual([r.success, r.error], [false, 'Connect your ELMS Extension Key first.']);

  // ---- only ELMS's own pages are opened ----
  env = boot({ respond: () => SETTINGS });
  r = await env.message({ type: 'ELMS_OPEN_URL', url: 'https://elmstool.com/draft?open=D1' });
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(env.tabs.created, ['https://elmstool.com/draft?open=D1']);
  for (const bad of ['https://evil.example/draft', 'http://elmstool.com/draft', 'javascript:alert(1)', 'not a url', 'https://elmstool.com.evil.example/x']) {
    r = await env.message({ type: 'ELMS_OPEN_URL', url: bad });
    assert.strictEqual(r.success, false, bad);
  }
  assert.strictEqual(env.tabs.created.length, 1, 'nothing else was opened');
  env.store.appUrl = 'https://app.example.test';
  r = await env.message({ type: 'ELMS_OPEN_URL', url: 'https://app.example.test/draft' });
  assert.strictEqual(r.success, true, 'the address ELMS itself gave is fine too');

  // ---- the page may use only a few ELMS calls (bulk import) ----
  env = boot({ respond: (c) => (c.url.endsWith('/extension-settings') ? SETTINGS : { status: 200, body: { success: true, known: [], jobId: 'J1' } }) });
  const jobId = 'a'.repeat(24);
  for (const [method, p] of [['POST', '/api/extension/known'], ['POST', '/api/extension/market'], ['GET', '/api/fetch-product/limits'], ['POST', '/api/fetch-product/bulk'], ['POST', '/api/fetch-product/bulk-job'], ['GET', '/api/fetch-product/bulk-job/' + jobId]]) {
    r = await env.message({ type: 'ELMS_API', method, path: p, body: p.endsWith('known') ? { asins: ['B0TEST0001'] } : undefined });
    assert.strictEqual(r.success, true, method + ' ' + p);
  }
  const sentKnown = env.fetches.find((c) => c.url.endsWith('/api/extension/known'));
  assert.deepStrictEqual(sentKnown.body, { asins: ['B0TEST0001'] });
  assert.strictEqual(sentKnown.auth, 'Bearer old-token');
  const before = env.fetches.length;
  for (const [method, p] of [['GET', '/api/auth/me'], ['POST', '/api/admin/users'], ['DELETE', '/api/fetch-product/bulk-job/' + jobId], ['GET', '/api/fetch-product/bulk-job/../../auth/me'], ['GET', '/api/fetch-product/bulk-job/xyz'], ['POST', '/api/browser-import'], ['GET', 'https://evil.example/api/extension/known']]) {
    r = await env.message({ type: 'ELMS_API', method, path: p });
    assert.strictEqual(r.success, false, method + ' ' + p);
    assert.strictEqual(r.error, 'That call is not allowed.');
  }
  assert.strictEqual(env.fetches.length, before, 'a call that is not allowed never reaches ELMS');

  // ---- other messages are not ours; the keyboard shortcut reaches the page ----
  assert.strictEqual(env.listeners.message({ type: 'SOMETHING_ELSE' }, {}, () => {}), false);
  await env.listeners.command('import-product');
  await env.listeners.command('another-command');
  assert.deepStrictEqual(env.tabs.sent, [[7, 'ELMS_TRIGGER_IMPORT']]);

  console.log('extension background tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
