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
      await chrome.storage.local.set({ backend });
      return backend;
    }
  } catch (_) {}
  return fallback;
}

function showConnected(user) {
  $('keySection').classList.add('hidden');
  $('connectedCard').classList.remove('hidden');
  $('disconnect').classList.remove('hidden');
  const username = user?.username || user?.name || 'ELMS Account';
  $('connectedUsername').textContent = username;
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
  const data = await chrome.storage.local.get(['extensionKey', 'markup', 'connectedUser']);
  $('markup').value = data.markup ?? '';
  if (data.extensionKey) {
    showConnected(data.connectedUser || {});
  } else {
    showDisconnected();
  }
  const backend = await resolveBackend();
  try {
    const r = await fetch(`${backend}/api/auth/extension-settings`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.registrationUrl) {
      $('registerLink').href = j.registrationUrl;
      $('registerLink').target = '_blank';
    }
  } catch (_) {}
}

async function exchangeExtensionKey(key, backend) {
  const r = await fetch(`${backend}/api/auth/extension-key/exchange`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ extensionKey:key })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok || !j.success || !j.sessionToken) throw new Error(j.error || `Could not connect to ELMS (${r.status}).`);
  return j;
}

async function ensureContentScript(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, {type:'ELMS_GET_PRODUCT'}); }
  catch (_) {
    await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
    await new Promise(r=>setTimeout(r,150));
    return await chrome.tabs.sendMessage(tabId,{type:'ELMS_GET_PRODUCT'});
  }
}

function renderPreview(product) {
  const p=$('preview');
  if(!product){p.classList.add('hidden');return;}
  p.classList.remove('hidden');
  const thumb=product.images?.[0]?`<img src="${escapeHtml(product.images[0])}" alt="">`:'';
  p.innerHTML=`${thumb}<div><strong>${escapeHtml(product.title||'Product')}</strong><div class="stats">${product.images?.length||0} images · ${product.specifications?.length||0} specs${product.price!=null?` · ${escapeHtml(Number(product.price).toFixed(2))}`:''}</div></div>`;
}
function escapeHtml(s){return String(s||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

$('connect').addEventListener('click', async()=>{
  const key=$('extensionKey').value.trim();
  if(!key) return void($('status').textContent='Paste your ELMS Extension Key first.');
  const button=$('connect');
  button.disabled=true;
  try {
    $('status').textContent='Connecting securely…';
    const backend=await resolveBackend();
    const result=await exchangeExtensionKey(key,backend);
    const user=result.user || {};
    await chrome.storage.local.set({extensionKey:key,backend,sessionToken:result.sessionToken,markup:$('markup').value.trim(),connectedUser:user});
    showConnected(user);
    $('status').innerHTML='<span class="connected-text">✓ Connected successfully</span>';
  } catch(e) {
    $('status').innerHTML=`<span class="notconnected">Connection failed</span>\n${escapeHtml(e.message)}`;
  } finally { button.disabled=false; }
});

$('disconnect').addEventListener('click', async()=>{
  await chrome.storage.local.remove(['extensionKey','sessionToken','connectedUser']);
  showDisconnected();
  $('status').innerHTML='<span class="connected-text">✓ ELMS disconnected. You can add another key.</span>';
});

$('markup').addEventListener('change', async()=>{
  await chrome.storage.local.set({markup:$('markup').value.trim()});
});

$('import').addEventListener('click',async()=>{
  renderPreview(null); $('status').textContent='Reading the current Amazon page…';
  try {
    const data=await chrome.storage.local.get(['extensionKey','markup','sessionToken','backend']);
    const key=String(data.extensionKey||'').trim();
    if(!key) throw new Error('Connect your ELMS account first.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id || !/^https:\/\/(www\.)?amazon\./i.test(tab.url||'')) throw new Error('Open an Amazon product page first.');
    const extracted=await ensureContentScript(tab.id);
    if(!extracted?.success) throw new Error(extracted?.error||'Could not read the Amazon page.');
    renderPreview(extracted.product); $('status').textContent='Connecting to ELMS…';
    const backend=await resolveBackend();
    let token=data.sessionToken;
    let user=data.connectedUser;
    if(!token){
      const result=await exchangeExtensionKey(key,backend);
      token=result.sessionToken; user=result.user||user;
      await chrome.storage.local.set({sessionToken:token,backend,connectedUser:user});
      showConnected(user||{});
    }
    const markup=$('markup').value.trim() || data.markup || '';
    $('status').textContent='Saving product to ELMS Drafts…';
    const payload={amazonUrl:tab.url,product:extracted.product};
    if(markup!=='') payload.markupPercent=Number(markup);
    const r=await fetch(`${backend}/api/browser-import`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.success) throw new Error(j.error||`Import failed (${r.status}).`);
    await chrome.storage.local.set({backend,markup});
    $('status').innerHTML=`<span class="connected-text">✓ Saved to ELMS Drafts</span>\nASIN: ${escapeHtml(j.product.asin||'—')}\nAmazon: ${j.product.price!=null?escapeHtml(Number(j.product.price).toFixed(2)):'—'} · Selling: ${j.suggestedPrice!=null?escapeHtml(Number(j.suggestedPrice).toFixed(2)):'—'}`;
  } catch(e) { $('status').innerHTML=`<span class="notconnected">Import failed</span>\n${escapeHtml(e.message||'Import failed.')}`; }
});

load().catch((e)=>{ $('status').textContent=e?.message||'Unable to load ELMS settings.'; });
