const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const BACKEND_RECHECK_MS = 10 * 60 * 1000;
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');

// The address of the ELMS backend is set in the ELMS Admin Panel; it is asked for again at most every ten minutes
// (every product page the panel opens would otherwise ask twice).
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
// Rejects with Error(message) plus .status / .code / .data when ELMS answered with an error.
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

// Only ELMS's own pages are ever opened for the page's script.
async function openInElms(url) {
  const { appUrl } = await chrome.storage.local.get(['appUrl']);
  let allowed;
  try { allowed = new URL(appUrl || 'https://elmstool.com'); } catch (_) { allowed = new URL('https://elmstool.com'); }
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.hostname !== 'localhost') throw new Error('Not an ELMS address.');
  if (target.host !== allowed.host && target.host !== 'elmstool.com' && target.host !== 'www.elmstool.com') throw new Error('Not an ELMS address.');
  await chrome.tabs.create({ url: target.href });
}

// The few ELMS calls the page's script may make through this script (a page cannot call ELMS itself: it is another origin).
const API_ALLOWED = [
  /^POST \/api\/extension\/known$/,
  /^POST \/api\/extension\/market$/,
  /^GET \/api\/fetch-product\/limits$/,
  /^POST \/api\/fetch-product\/bulk$/,
  /^POST \/api\/fetch-product\/bulk-job$/,
  /^GET \/api\/fetch-product\/bulk-job\/[a-f0-9]{24}$/,
];

const routes = {
  ELMS_IMPORT_PRODUCT: (m) => api('/api/browser-import', { method: 'POST', body: { amazonUrl: m.amazonUrl, product: m.product, markupPercent: m.markupPercent, ebayAccountId: m.ebayAccountId || undefined } }),
  ELMS_CHECK: (m) => api('/api/extension/check', { method: 'POST', body: m.payload || {}, timeoutMs: 60000 }),
  ELMS_OPEN_URL: (m) => openInElms(m.url),
  ELMS_API: (m) => {
    const method = String(m.method || 'GET').toUpperCase();
    if (!API_ALLOWED.some((re) => re.test(method + ' ' + m.path))) return Promise.reject(new Error('That call is not allowed.'));
    return api(m.path, { method, body: m.body, timeoutMs: Math.min(Number(m.timeoutMs) || 120000, 180000) });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = message && routes[message.type];
  if (!run) return false;
  run(message).then(
    (result) => sendResponse({ success: true, result }),
    (error) => sendResponse({ success: false, error: error?.message || 'Something went wrong.', status: error?.status, code: error?.code }),
  );
  return true;
});

// Keyboard shortcut (chrome://extensions/shortcuts): the same as pressing the ELMS button on the page.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'import-product') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ELMS_TRIGGER_IMPORT' }).catch(() => {});
});
