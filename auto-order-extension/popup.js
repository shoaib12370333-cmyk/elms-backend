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
  $('controlsCard').classList.remove('hidden');
  $('disconnect').classList.remove('hidden');
  $('connectedUsername').textContent = user?.username || user?.name || 'ELMS Account';
  $('connectedEmail').textContent = user?.email || '';
}

function showDisconnected() {
  $('keySection').classList.remove('hidden');
  $('connectedCard').classList.add('hidden');
  $('controlsCard').classList.add('hidden');
  $('disconnect').classList.add('hidden');
  $('extensionKey').value = '';
  $('status').textContent = '';
}

function historyLine(entry) {
  const when = new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (entry.placed) return { cls: 'ok', text: `${when} &middot; Placed &middot; Amazon order ${escapeHtml(entry.amazonOrderId || '')}` };
  if (entry.blocked) return { cls: 'warn', text: `${when} &middot; Needs attention &middot; ${escapeHtml(entry.reason || '')}` };
  if (entry.failed || entry.error) return { cls: 'bad', text: `${when} &middot; ${escapeHtml(entry.error || entry.reason || 'Failed')}` };
  if (entry.started) return { cls: '', text: `${when} &middot; Started an order` };
  if (entry.idle) return { cls: '', text: `${when} &middot; Nothing to do${entry.reason ? ' (' + escapeHtml(entry.reason) + ')' : ''}` };
  return { cls: '', text: `${when} &middot; Checked` };
}

function renderState(state) {
  $('onToggle').checked = !!state.autoOrderOn;
  $('pauseToggle').checked = !!state.paused;
  $('manualToggle').checked = !!state.manualMode;
  $('manualWarn').classList.toggle('hidden', !state.manualMode);
  const jobBox = $('jobBox');
  const stopBtn = $('stopNow');
  const pendingBox = $('pendingBox');
  if (state.active) {
    jobBox.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    jobBox.innerHTML = `Working on eBay order <b>${escapeHtml(state.active.order?.ebay_order_id || '')}</b> &middot; step: <b>${escapeHtml(state.active.step || 'loading')}</b>`;
    if (state.active.pendingStep) {
      pendingBox.classList.remove('hidden');
      $('pendingDesc').textContent = state.active.pendingStep.description || '';
    } else {
      pendingBox.classList.add('hidden');
    }
  } else {
    jobBox.classList.add('hidden');
    stopBtn.classList.add('hidden');
    pendingBox.classList.add('hidden');
  }
  $('history').innerHTML = (state.history || []).map((e) => { const l = historyLine(e); return `<li class="${l.cls}">${l.text}</li>`; }).join('') || '<li>No activity yet.</li>';
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: 'AO_GET_STATE' });
  if (state) renderState(state);
}

async function load() {
  const data = await chrome.storage.local.get(['extensionKey', 'connectedUser']);
  if (data.extensionKey) {
    showConnected(data.connectedUser || {});
    refreshState();
  } else {
    showDisconnected();
  }
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
    refreshState();
  } catch (e) {
    $('status').innerHTML = `<span class="notconnected">Connection failed</span>\n${escapeHtml(e.message)}`;
  } finally { button.disabled = false; }
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['extensionKey', 'sessionToken', 'connectedUser', 'autoOrderOn']);
  showDisconnected();
  $('status').innerHTML = '<span class="connected-text">✓ ELMS disconnected.</span>';
});

$('onToggle').addEventListener('change', async (e) => {
  await chrome.runtime.sendMessage({ type: 'AO_SET_ON', on: e.target.checked });
  refreshState();
});
$('pauseToggle').addEventListener('change', async (e) => {
  await chrome.runtime.sendMessage({ type: 'AO_SET_PAUSED', paused: e.target.checked });
  refreshState();
});
$('manualToggle').addEventListener('change', async (e) => {
  await chrome.runtime.sendMessage({ type: 'AO_SET_MANUAL', manual: e.target.checked });
  refreshState();
});
$('approveStep').addEventListener('click', async () => {
  $('approveStep').disabled = true;
  await chrome.runtime.sendMessage({ type: 'AO_APPROVE_STEP' });
  $('approveStep').disabled = false;
  refreshState();
});
$('stopNow').addEventListener('click', async () => {
  $('stopNow').disabled = true;
  await chrome.runtime.sendMessage({ type: 'AO_STOP_NOW' });
  $('stopNow').disabled = false;
  refreshState();
});

load().catch((e) => { $('status').textContent = e?.message || 'Unable to load ELMS settings.'; });
setInterval(refreshState, 4000);
