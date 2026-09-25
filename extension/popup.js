const $ = (id) => document.getElementById(id);
const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');
const LOGIC = globalThis.ELMS_LOGIC;
const FEE_FIELDS = ['feePct', 'fixed', 'adPct', 'targetPct'];

let info = null;              // ELMS's answer: credits, stores, appUrl
const askedAbout = new Set(); // ASINs the person has been told are already in Drafts (the second press imports)

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

// The background script talks to ELMS (it renews an expired session by itself).
async function ask(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { success: false, error: 'ELMS did not answer.' };
  } catch (e) {
    return { success: false, error: e?.message || 'ELMS did not answer.' };
  }
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
  info = null;
  renderInfo();
}

// What an import costs, the way people read it: "Free" when the admin made it free.
const costLabel = (n) => (n === 0 ? 'Free' : n + ' credit' + (n === 1 ? '' : 's'));

// Credits and stores (free): shown under the account and in the store list.
function renderInfo() {
  const stores = info?.stores || [];
  const credits = info?.credits;
  $('credits').innerHTML = credits
    ? (credits.unlimited ? '<b>Unlimited</b> credits' : `You have <b>${credits.balance}</b> credit${credits.balance === 1 ? '' : 's'}`) + (credits.importCost === 0 ? ' &middot; an import is <b>free</b>' : ` &middot; an import costs <b>${credits.importCost}</b>`)
    : '';
  $('storeField').classList.toggle('hidden', stores.length < 2);
  const chosen = chosenStoreId();
  $('store').replaceChildren(...stores.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: s.label, selected: s.id === chosen })));
}

function chosenStoreId(saved) {
  const stores = info?.stores || [];
  const id = saved !== undefined ? saved : $('store').value;
  return (stores.find((s) => s.id === id) || stores.find((s) => s.isActive) || stores[0] || {}).id || null;
}

async function loadInfo() {
  const r = await ask({ type: 'ELMS_CHECK', payload: {} });
  if (r.success) {
    info = r.result;
    if (info.appUrl) chrome.storage.local.set({ appUrl: info.appUrl });
    const { storeId } = await chrome.storage.local.get(['storeId']);
    renderInfo();
    if (storeId) $('store').value = chosenStoreId(storeId) || '';
  }
}

async function load() {
  const data = await chrome.storage.local.get(['extensionKey', 'markup', 'connectedUser', 'fees', 'autoOpen', 'skipVariants']);
  $('markup').value = data.markup ?? '';
  const fees = data.fees || {};
  FEE_FIELDS.forEach((k) => { $(k).value = fees[k] ?? ''; $(k).placeholder = String(LOGIC.DEFAULTS[k]); });
  $('autoOpen').checked = !!data.autoOpen;
  $('skipVariants').checked = !!data.skipVariants;
  if (data.extensionKey) {
    showConnected(data.connectedUser || {});
    loadInfo();
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
    await chrome.scripting.executeScript({target:{tabId},files:['logic.js','content.js']});
    await new Promise(r=>setTimeout(r,150));
    return await chrome.tabs.sendMessage(tabId,{type:'ELMS_GET_PRODUCT'});
  }
}

function renderPreview(product) {
  const p=$('preview');
  if(!product){p.classList.add('hidden');return;}
  p.classList.remove('hidden');
  const thumb=product.images?.[0]?`<img src="${escapeHtml(product.images[0])}" alt="">`:'';
  p.innerHTML=`${thumb}<div><strong>${escapeHtml(product.title||'Product')}</strong><div class="stats">${product.images?.length||0} images · ${product.specifications?.length||0} specs${product.variants?.length?` · ${product.variants.length} variants`:''}${product.price!=null?` · ${escapeHtml(Number(product.price).toFixed(2))}`:''}</div></div>`;
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
    loadInfo();
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

$('store').addEventListener('change', () => chrome.storage.local.set({ storeId: $('store').value }));

// Profit settings: what is typed is kept as typed; the panel on the page reads it through LOGIC.normalizeSettings.
FEE_FIELDS.forEach((k) => $(k).addEventListener('change', () => {
  const fees = {};
  FEE_FIELDS.forEach((f) => { const v = $(f).value.trim(); if (v !== '') fees[f] = v; });
  chrome.storage.local.set({ fees });
}));
$('autoOpen').addEventListener('change', () => chrome.storage.local.set({ autoOpen: $('autoOpen').checked }));
$('skipVariants').addEventListener('change', () => chrome.storage.local.set({ skipVariants: $('skipVariants').checked }));

let openTarget = null;
$('openDraft').addEventListener('click', () => { if (openTarget) ask({ type: 'ELMS_OPEN_URL', url: openTarget }); });

$('import').addEventListener('click',async()=>{
  const button=$('import');
  let holdLabel=false; // true while the button asks for a second press
  renderPreview(null); $('openDraft').classList.add('hidden'); $('status').textContent='Reading the current Amazon page and its variants…';
  button.disabled=true;
  try {
    const data=await chrome.storage.local.get(['extensionKey','markup']);
    const key=String(data.extensionKey||'').trim();
    if(!key) throw new Error('Connect your ELMS account first.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id || !/^https:\/\/(www\.)?amazon\./i.test(tab.url||'')) throw new Error('Open an Amazon product page first.');
    const extracted=await ensureContentScript(tab.id);
    if(!extracted?.success) throw new Error(extracted?.error||'Could not read the Amazon page.');
    const product=extracted.product;
    renderPreview(product);

    // A draft that is already there is refreshed for another credit: ask once before doing it.
    if(product.asin && !askedAbout.has(product.asin)){
      $('status').textContent='Checking ELMS…';
      const c=await ask({type:'ELMS_CHECK',payload:{asin:product.asin,amazonUrl:tab.url,title:product.title,brand:product.brand}});
      if(c.success){
        info=c.result; renderInfo();
        const {here}=LOGIC.locate(info,chosenStoreId());
        if(here && here.status==='draft'){
          askedAbout.add(product.asin);
          holdLabel=true;
          button.textContent=`Refresh the draft · ${costLabel(info.credits.importCost)}`;
          $('status').innerHTML=`<span class="warn-text">Already in your Drafts.</span>\nImporting again refreshes it${info.credits.importCost === 0 ? ' (free)' : ' and costs ' + costLabel(info.credits.importCost)}. Press the button again to do it.`;
          return;
        }
      }
    }

    $('status').textContent='Saving product to ELMS Drafts…';
    const markup=$('markup').value.trim() || data.markup || '';
    const r=await ask({type:'ELMS_IMPORT_PRODUCT',product,amazonUrl:tab.url,markupPercent:markup!==''&&Number.isFinite(Number(markup))?Number(markup):undefined,ebayAccountId:chosenStoreId()||undefined});
    if(!r.success) throw new Error(r.error||'Import failed.');
    const j=r.result;
    await chrome.storage.local.set({markup});
    askedAbout.delete(product.asin);
    if(info?.credits && j.creditsLeft!=null){ info.credits.balance=j.creditsLeft; renderInfo(); }
    $('status').innerHTML=`<span class="connected-text">✓ Saved to ELMS Drafts</span>\nASIN: ${escapeHtml(j.product.asin||'—')}${j.store?.label?` · ${escapeHtml(j.store.label)}`:''}\nAmazon: ${j.product.price!=null?escapeHtml(Number(j.product.price).toFixed(2)):'—'} · Selling: ${j.suggestedPrice!=null?escapeHtml(Number(j.suggestedPrice).toFixed(2)):'—'}`;
    if(j.draft?.id){
      openTarget=`${String(j.appUrl||info?.appUrl||'https://elmstool.com').replace(/\/+$/,'')}/draft?open=${encodeURIComponent(j.draft.id)}`;
      $('openDraft').classList.remove('hidden');
      if($('autoOpen').checked) ask({type:'ELMS_OPEN_URL',url:openTarget});
    }
  } catch(e) { $('status').innerHTML=`<span class="notconnected">Import failed</span>\n${escapeHtml(e.message||'Import failed.')}`; }
  finally { button.disabled=false; if(!holdLabel) button.textContent='Import current Amazon product'; }
});

load().catch((e)=>{ $('status').textContent=e?.message||'Unable to load ELMS settings.'; });
