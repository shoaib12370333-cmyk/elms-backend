const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const BACKEND_RECHECK_MS = 10 * 60 * 1000;
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');

// The address of the ELMS backend is set in the ELMS Admin Panel; it is asked for again at most every ten minutes.
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

// One call to ELMS as the connected user. An expired session is renewed once from the Extension Key.
async function api(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
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
  if (!r.ok || !j.success) throw new Error(j.error || `ELMS answered with an error (${r.status}).`);
  return j;
}

// Which ELMS order a browser TAB belongs to (set the moment the seller opens Amazon from that order's own "AMAZON"
// link in ELMS) - kept in session storage, not a plain in-memory variable, since this service worker can be evicted
// and restarted at any moment between the click and the seller eventually finishing checkout, minutes later.
const tabKey = (tabId) => `tab_order_${tabId}`;

const routes = {
  // The buyer's own shipping address (already on the ELMS order) - shown so the seller can copy/paste it onto
  // Amazon's address form themselves. Never written back to Amazon in any way.
  ELMS_GET_ORDER: (m) => api(`/api/orders/${encodeURIComponent(m.orderId)}`).then((j) => j.order),
  ELMS_MARK_ORDERED: (m) => api(`/api/orders/${encodeURIComponent(m.orderId)}/ordered`, {
    method: 'POST',
    body: { ordered: true, deliveryDate: m.deliveryDate || null, buyingPrice: m.buyingPrice },
  }).then((j) => j.order),
  ELMS_REMEMBER_TAB_ORDER: async (m, sender) => {
    if (!sender?.tab?.id) return false;
    await chrome.storage.session.set({ [tabKey(sender.tab.id)]: m.orderId });
    return true;
  },
  ELMS_GET_TAB_ORDER: async (_m, sender) => {
    if (!sender?.tab?.id) return null;
    const data = await chrome.storage.session.get(tabKey(sender.tab.id));
    return data[tabKey(sender.tab.id)] || null;
  },
  ELMS_FORGET_TAB_ORDER: async (_m, sender) => {
    if (sender?.tab?.id) await chrome.storage.session.remove(tabKey(sender.tab.id));
    return true;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = message && routes[message.type];
  if (!run) return false;
  run(message, sender).then(
    (result) => sendResponse({ success: true, result }),
    (error) => sendResponse({ success: false, error: error?.message || 'Something went wrong.' }),
  );
  return true;
});

// A tab closed without ever reaching checkout: forget it rather than leaving it in session storage forever.
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(tabKey(tabId)).catch(() => {}); });
