const $ = (id) => document.getElementById(id);
const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');

async function resolveBackend() {
  const cached = await chrome.storage.local.get(['backend']);
  const fallback = normalizeUrl(cached.backend) || BOOTSTRAP_BACKEND;
  try {
    const r = await fetch(`${BOOTSTRAP_BACKEND}/api/auth/extension-settings`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.backendUrl) {
      const backend = normalizeUrl(j.backendUrl);
      await chrome.storage.local.set({ backend, backendCheckedAt: Date.now() });
      return backend;
    }
  } catch (_) {}
  return fallback;
}

async function exchangeExtensionKey(key, backend) {
  const r = await fetch(`${backend}/api/auth/extension-key/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extensionKey: key }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success || !j.sessionToken) throw new Error(j.error || `Could not connect to ELMS (${r.status}).`);
  return j;
}

function escapeHtml(s) { return String(s || '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

function showConnected(user) {
  $('keySection').classList.add('hidden');
  $('connectedCard').classList.remove('hidden');
  $('disconnect').classList.remove('hidden');
  $('connectedUsername').textContent = user?.username || user?.name || 'ELMS Account';
  $('connectedEmail').textContent = user?.email || '';
}

function showDisconnected() {
  $('keySection').classList.remove('hidden');
  $('connectedCard').classList.add('hidden');
  $('disconnect').classList.add('hidden');
  $('extensionKey').value = '';
  $('status').textContent = '';
}

async function load() {
  const data = await chrome.storage.local.get(['extensionKey', 'connectedUser']);
  if (data.extensionKey) showConnected(data.connectedUser || {});
  else showDisconnected();
  const backend = await resolveBackend();
  try {
    const r = await fetch(`${backend}/api/auth/extension-settings`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.registrationUrl) { $('registerLink').href = j.registrationUrl; $('registerLink').target = '_blank'; }
  } catch (_) {}
}

$('connect').addEventListener('click', async () => {
  const key = $('extensionKey').value.trim();
  if (!key) return void ($('status').textContent = 'Paste your ELMS Extension Key first.');
  const button = $('connect');
  button.disabled = true;
  try {
    $('status').textContent = 'Connecting securely…';
    const backend = await resolveBackend();
    const result = await exchangeExtensionKey(key, backend);
    const user = result.user || {};
    await chrome.storage.local.set({ extensionKey: key, backend, sessionToken: result.sessionToken, connectedUser: user });
    showConnected(user);
    $('status').innerHTML = '<span class="connected-text">✓ Connected successfully</span>';
  } catch (e) {
    $('status').innerHTML = `<span class="notconnected">Connection failed</span>\n${escapeHtml(e.message)}`;
  } finally { button.disabled = false; }
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['extensionKey', 'sessionToken', 'connectedUser']);
  showDisconnected();
  $('status').innerHTML = '<span class="connected-text">✓ ELMS disconnected.</span>';
});

load().catch((e) => { $('status').textContent = e?.message || 'Unable to load ELMS settings.'; });
