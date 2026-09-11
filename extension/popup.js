const $ = (id) => document.getElementById(id);
const DEFAULT_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');

async function load() {
  const data = await chrome.storage.local.get(['extensionKey', 'backend', 'markup']);
  $('extensionKey').value = data.extensionKey || '';
  $('backend').value = data.backend || DEFAULT_BACKEND;
  $('markup').value = data.markup ?? '';
}
async function loadRegistrationUrl() {
  const backend = normalizeUrl($('backend').value) || DEFAULT_BACKEND;
  try {
    const r = await fetch(`${backend}/api/auth/extension-settings`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.registrationUrl) return j.registrationUrl;
  } catch (_) {}
  return '';
}

async function save() {
  await chrome.storage.local.set({ extensionKey: $('extensionKey').value.trim(), backend: normalizeUrl($('backend').value) || DEFAULT_BACKEND, markup: $('markup').value.trim() });
  $('status').textContent = 'Settings saved.';
}
async function exchangeExtensionKey(key, backend) {
  const r = await fetch(`${backend}/api/auth/extension-key/exchange`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ extensionKey:key }) });
  const j = await r.json().catch(()=>({}));
  if (!r.ok || !j.success || !j.sessionToken) throw new Error(j.error || `Could not connect to ELMS (${r.status}).`);
  return j.sessionToken;
}
async function ensureContentScript(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, {type:'ELMS_GET_PRODUCT'}); }
  catch (_) {
    await chrome.scripting.executeScript({ target:{tabId}, files:['content.js'] });
    await new Promise(r=>setTimeout(r,150));
    return await chrome.tabs.sendMessage(tabId, {type:'ELMS_GET_PRODUCT'});
  }
}
function renderPreview(product) {
  const p = $('preview');
  if (!product) { p.hidden = true; return; }
  p.hidden = false;
  p.innerHTML = `<strong>${escapeHtml(product.title || 'Product')}</strong><div class="stats">${product.images?.length || 0} images · ${product.specifications?.length || 0} specs · ${product.variants?.length || 0} ASINs · ${product.categories?.length || 0} categories</div>`;
}
function escapeHtml(s) { return String(s || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

$('save').addEventListener('click', save);
$('connect').addEventListener('click', async () => {
  const key = $('extensionKey').value.trim(), backend = normalizeUrl($('backend').value) || DEFAULT_BACKEND;
  if (!key) return void ($('status').textContent = 'Paste your ELMS Extension Key first.');
  try { $('status').textContent='Connecting...'; const token=await exchangeExtensionKey(key, backend); await chrome.storage.local.set({extensionKey:key, backend, markup:$('markup').value.trim(), sessionToken:token}); $('status').innerHTML='<span class="connected">✓ ELMS account connected</span>'; }
  catch(e) { $('status').innerHTML=`<span class="notconnected">Not connected</span>\n${escapeHtml(e.message)}`; }
});
$('import').addEventListener('click', async () => {
  renderPreview(null); $('status').textContent='Reading the current Amazon page...';
  const data=await chrome.storage.local.get(['extensionKey','backend','markup']);
  const key=String(data.extensionKey||$('extensionKey').value||'').trim(), backend=normalizeUrl(data.backend||$('backend').value)||DEFAULT_BACKEND, markup=data.markup ?? $('markup').value.trim();
  if(!key) return void ($('status').textContent='Paste your ELMS Extension Key first.');
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id || !/^https:\/\/(www\.)?amazon\./i.test(tab.url||'')) throw new Error('Open an Amazon product page first.');
    const extracted=await ensureContentScript(tab.id);
    if(!extracted?.success) throw new Error(extracted?.error||'Could not read the Amazon page.');
    renderPreview(extracted.product); $('status').textContent='Connecting to ELMS...';
    const token=await exchangeExtensionKey(key,backend);
    $('status').textContent='Saving complete product to ELMS Drafts...';
    const r=await fetch(`${backend}/api/browser-import`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({amazonUrl:tab.url,product:extracted.product,markupPercent:markup===''?undefined:Number(markup)})});
    const j=await r.json().catch(()=>({})); if(!r.ok||!j.success) throw new Error(j.error||`Import failed (${r.status}).`);
    $('status').innerHTML=`<span class="connected">✓ Saved to ELMS Drafts</span>\nASIN: ${escapeHtml(j.product.asin)}\nImages: ${j.product.images?.length||0} · Specs: ${j.product.specifications?.length||0}`;
  } catch(e) { $('status').textContent=e.message||'Import failed.'; }
});

// Fetch a product straight from a pasted Amazon link - no need to have the
// page open in a tab. Unlike "Import current Amazon product" (which reads
// the DOM of the currently open Amazon tab for free), this calls the ELMS
// backend's /api/fetch-product route, which fetches the product itself via
// the Canopy API and spends one ELMS credit, same as pasting the link on
// the ELMS website's Import page.
$('fetchLink').addEventListener('click', async () => {
  renderPreview(null);
  const amazonUrl = $('amazonLink').value.trim();
  if (!amazonUrl) return void ($('status').textContent = 'Paste an Amazon product link first.');
  if (!/^https:\/\/(www\.)?amazon\.[a-z.]+\//i.test(amazonUrl)) {
    return void ($('status').textContent = 'That does not look like a valid Amazon product link.');
  }
  const data = await chrome.storage.local.get(['extensionKey', 'backend', 'markup']);
  const key = String(data.extensionKey || $('extensionKey').value || '').trim();
  const backend = normalizeUrl(data.backend || $('backend').value) || DEFAULT_BACKEND;
  const markup = data.markup ?? $('markup').value.trim();
  if (!key) return void ($('status').textContent = 'Paste your ELMS Extension Key first.');
  try {
    $('status').textContent = 'Connecting to ELMS...';
    const token = await exchangeExtensionKey(key, backend);
    $('status').textContent = 'Fetching product from the link…';
    const r = await fetch(`${backend}/api/fetch-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amazonUrl, markupPercent: markup === '' ? undefined : Number(markup) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || `Fetch failed (${r.status}).`);
    renderPreview(j.product);
    $('status').innerHTML = `<span class="connected">✓ Saved to ELMS Drafts</span>\nASIN: ${escapeHtml(j.product.asin)}\nImages: ${j.product.images?.length || 0} · Specs: ${j.product.specifications?.length || 0}`;
  } catch (e) {
    $('status').textContent = e.message || 'Fetch failed.';
  }
});

$('registerLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const url = await loadRegistrationUrl();
  if (!url || !/^https?:\/\//i.test(url)) {
    $('status').textContent = 'Registration link is not configured yet. Please contact ELMS support.';
    return;
  }
  chrome.tabs.create({ url });
});

load();
