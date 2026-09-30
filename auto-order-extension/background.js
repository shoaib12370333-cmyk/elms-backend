const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const BACKEND_RECHECK_MS = 10 * 60 * 1000;
const POLL_MINUTES = 3;
const STALE_JOB_MS = 12 * 60 * 1000; // a tab that never reports back this long is treated as lost, not left stuck forever
const HISTORY_LIMIT = 10;
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');

// Every Amazon site ELMS knows about (config/amazonDomains.js on the backend) that this extension's host_permissions
// actually cover. An order from any other Amazon site is refused up front, before a tab is even opened, rather than
// silently failing partway through - see startJob().
const SUPPORTED_AMAZON_HOSTS = /(^|\.)amazon\.(com|co\.uk|ca|de|fr|it|es|in|com\.au)$/i;

// ---------------------------------------------------------------- ELMS auth (identical to extension/background.js -
// same Extension Key, same session token, same bootstrap - the seller connects both extensions with one key).
async function resolveBackend() {
  const data = await chrome.storage.local.get(['backend', 'backendCheckedAt']);
  const cached = normalizeUrl(data.backend);
  if (cached && Date.now() - Number(data.backendCheckedAt || 0) < BACKEND_RECHECK_MS) return cached;
  try {
    const r = await fetch(`${BOOTSTRAP_BACKEND}/api/auth/extension-settings`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.backendUrl) {
      const backend = normalizeUrl(j.backendUrl);
      await chrome.storage.local.set({ backend, backendCheckedAt: Date.now() });
      return backend;
    }
  } catch (_) { /* the last known address is used */ }
  return cached || BOOTSTRAP_BACKEND;
}

async function exchange(key, backend) {
  const r = await fetch(`${backend}/api/auth/extension-key/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extensionKey: key }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success || !j.sessionToken) throw new Error(j.error || `Could not connect to ELMS (${r.status}).`);
  await chrome.storage.local.set({ sessionToken: j.sessionToken, backend });
  return j.sessionToken;
}

async function getSession() {
  const data = await chrome.storage.local.get(['extensionKey', 'sessionToken']);
  const key = String(data.extensionKey || '').trim();
  if (!key) throw new Error('Connect your ELMS Extension Key first.');
  const backend = await resolveBackend();
  return { key, backend, token: data.sessionToken || null };
}

async function api(path, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  let { key, backend, token } = await getSession();
  if (!token) token = await exchange(key, backend);
  const send = async (authToken) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${backend}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (_) {
      throw new Error('Could not reach ELMS. The server may be waking up: try again in a minute.');
    } finally {
      clearTimeout(timer);
    }
  };
  let r = await send(token);
  if (r.status === 401) { token = await exchange(key, backend); r = await send(token); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    const err = new Error(j.error || `ELMS answered with an error (${r.status}).`);
    err.status = r.status; err.code = j.code; err.data = j;
    throw err;
  }
  return j;
}

// ---------------------------------------------------------------- state (chrome.storage.local; a service worker can
// be killed at any time, so nothing about the in-flight job lives only in memory)
async function getState() {
  const d = await chrome.storage.local.get(['autoOrderOn', 'paused', 'active', 'lastPoll', 'history', 'manualMode']);
  return { autoOrderOn: !!d.autoOrderOn, paused: !!d.paused, active: d.active || null, lastPoll: d.lastPoll || null, history: d.history || [], manualMode: !!d.manualMode };
}

async function recordResult(entry) {
  const { history = [] } = await chrome.storage.local.get(['history']);
  const next = [{ at: Date.now(), ...entry }, ...history].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history: next, lastPoll: { at: Date.now(), ...entry } });
}

async function setActive(active) {
  await chrome.storage.local.set({ active });
}

async function closeJobTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (_) { /* already closed */ }
}

// A known, human-fixable block: the extension never retries these by itself (services/autoOrderService.js on the
// backend enforces the same rule - this is belt and braces, not the only place it is enforced).
async function failJob(active, reason, needsAttention = true) {
  try { await api(`/api/auto-order/${active.orderId}/failed`, { method: 'POST', body: { reason, needsAttention } }); }
  catch (err) { await recordResult({ orderId: active.orderId, error: `Could not report the failure to ELMS: ${err.message}` }); }
  await closeJobTab(active.tabId);
  await recordResult({ orderId: active.orderId, blocked: needsAttention, failed: !needsAttention, reason });
  await setActive(null);
}

async function placeJob(active, { amazonOrderId, amazonTotal, deliveryDate }) {
  try { await api(`/api/auto-order/${active.orderId}/placed`, { method: 'POST', body: { amazonOrderId, amazonTotal, deliveryDate } }); }
  catch (err) { await recordResult({ orderId: active.orderId, error: `Amazon order ${amazonOrderId} was placed, but ELMS could not be told: ${err.message}` }); }
  await closeJobTab(active.tabId);
  await recordResult({ orderId: active.orderId, placed: true, amazonOrderId, amazonTotal });
  await setActive(null);
}

// ---------------------------------------------------------------- starting a job
async function startJob(order, settings, manualMode) {
  if (!order.amazon_url || !SUPPORTED_AMAZON_HOSTS.test(safeHost(order.amazon_url))) {
    return failJob({ orderId: order.id, tabId: null }, 'This order\'s Amazon site is not one this extension supports yet.');
  }
  if (order.max_allowed_cost == null) {
    return failJob({ orderId: order.id, tabId: null }, 'No safe price limit could be worked out for this order.');
  }
  // Manual mode: the tab is opened in the foreground so the seller can actually watch it, and every risky action
  // waits for an explicit "Do it" in the popup (see AO_AWAIT_STEP/AO_APPROVE_STEP below) instead of clicking through
  // on its own - meant for a first, supervised run, not everyday use.
  const tab = await chrome.tabs.create({ url: order.amazon_url, active: !!manualMode });
  await setActive({ orderId: order.id, tabId: tab.id, step: 'loading', order, settings, manualMode: !!manualMode, pendingStep: null, approvedStep: null, startedAt: Date.now() });
  await recordResult({ orderId: order.id, started: true });
}

function safeHost(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }

// ---------------------------------------------------------------- the poll loop
async function tick() {
  const { autoOrderOn, paused, active, manualMode } = await getState();
  if (!autoOrderOn || paused) return;

  if (active) {
    if (Date.now() - (active.startedAt || 0) < STALE_JOB_MS) return; // still working on it
    // A generic "did not finish in time" is a mystery to the seller when the real cause is Manual mode sitting on
    // an unapproved step the whole time (the tab just closes, with no visible reason) - name that specific, common
    // cause plainly, since it is fixed by a setting, not a bug report.
    const reason = active.manualMode && active.pendingStep
      ? `Manual mode is on and "${active.pendingStep.description}" was never approved within ${Math.round(STALE_JOB_MS / 60000)} minutes. Turn Manual mode off in the popup for unattended background use, or approve steps faster.`
      : 'The browser automation did not finish in time.';
    await failJob(active, reason);
  }

  let next;
  try { next = await api('/api/auto-order/next'); }
  catch (err) { await recordResult({ error: err.message }); return; }

  if (!next.order) { await recordResult({ idle: true, reason: next.reason || null }); return; }
  await startJob(next.order, next.settings || {}, manualMode);
}

chrome.alarms?.create('auto-order-poll', { periodInMinutes: POLL_MINUTES });
chrome.alarms?.onAlarm.addListener((alarm) => (alarm.name === 'auto-order-poll' ? tick() : undefined));

// ---------------------------------------------------------------- messages: from the content script (the tab doing
// the actual Amazon automation) and from the popup (the seller's own on/off/pause/stop control)
const routes = {
  // The content script running on a fresh page load always announces itself; only the tab actually holding the
  // active job gets a job back - every other Amazon tab the seller has open stays completely inert.
  AO_ANNOUNCE: async (_m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { job: null };
    return { job: { order: active.order, step: active.step, settings: active.settings, manualMode: !!active.manualMode } };
  },
  AO_STEP: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { ok: false };
    await setActive({ ...active, step: m.step });
    return { ok: true };
  },
  // Manual mode only: the content script is about to do something and waits here (polling, not a held-open
  // response - a service worker can be evicted at any time) until the popup approves this exact step by name.
  AO_AWAIT_STEP: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { stopped: true };
    if (active.approvedStep === m.name) {
      await setActive({ ...active, pendingStep: null, approvedStep: null });
      return { proceed: true };
    }
    if (active.pendingStep?.name !== m.name || active.pendingStep?.description !== m.description) {
      await setActive({ ...active, pendingStep: { name: m.name, description: m.description } });
    }
    return { proceed: false };
  },
  AO_APPROVE_STEP: async () => {
    const { active } = await getState();
    if (!active || !active.pendingStep) return { ok: false };
    await setActive({ ...active, approvedStep: active.pendingStep.name });
    return { ok: true };
  },
  // The content script reports the numbers it actually read on the final review page; the pass/fail decision is
  // made here, not trusted from the page script's own opinion - a real purchase is one click away.
  AO_CHECKS: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { pass: false, reason: 'This job is no longer active.' };
    const { inStock, fulfilledByAmazon, total } = m;
    if (inStock === false) return { pass: false, reason: 'Amazon shows this item as out of stock.' };
    if (active.settings?.primeOnly && fulfilledByAmazon === false) return { pass: false, reason: 'This item is not sold/fulfilled by Amazon, and the seller only allows those.' };
    if (typeof total !== 'number' || !Number.isFinite(total)) return { pass: false, reason: 'Could not read a clear order total on the review page.' };
    if (total > active.order.max_allowed_cost) return { pass: false, reason: `The order total (${total}) is over the allowed limit (${active.order.max_allowed_cost}).` };
    try { await api(`/api/auto-order/${active.orderId}/placing`, { method: 'POST' }); }
    catch (err) { return { pass: false, reason: `ELMS refused to let this order be placed: ${err.message}` }; }
    await setActive({ ...active, step: 'placing' });
    return { pass: true };
  },
  AO_BLOCKED: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { ok: true };
    await failJob(active, m.reason || 'The page could not be handled.', true);
    return { ok: true };
  },
  AO_ERROR: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { ok: true };
    await failJob(active, m.reason || 'An unexpected error happened.', false);
    return { ok: true };
  },
  AO_PLACED: async (m, sender) => {
    const { active } = await getState();
    if (!active || active.tabId !== sender.tab?.id) return { ok: true };
    await placeJob(active, { amazonOrderId: m.amazonOrderId, amazonTotal: m.amazonTotal, deliveryDate: m.deliveryDate });
    return { ok: true };
  },
  // ---- popup ----
  AO_GET_STATE: async () => getState(),
  AO_SET_ON: async (m) => { await chrome.storage.local.set({ autoOrderOn: !!m.on }); if (m.on) tick(); return { ok: true }; },
  AO_SET_PAUSED: async (m) => { await chrome.storage.local.set({ paused: !!m.paused }); return { ok: true }; },
  AO_SET_MANUAL: async (m) => { await chrome.storage.local.set({ manualMode: !!m.manual }); return { ok: true }; },
  AO_STOP_NOW: async () => {
    const { active } = await getState();
    if (active) await failJob(active, 'Stopped by the seller.');
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = message && routes[message.type];
  if (!run) return false;
  run(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || 'Something went wrong.' }));
  return true;
});

chrome.runtime.onInstalled?.addListener(() => tick());
