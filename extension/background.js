const BOOTSTRAP_BACKEND = 'https://elms-backend-1-tr5h.onrender.com';
const normalizeUrl = (v) => String(v || '').trim().replace(/\/$/, '');
async function resolveBackend(){
  const data=await chrome.storage.local.get(['backend']);
  try{
    const r=await fetch(`${BOOTSTRAP_BACKEND}/api/auth/extension-settings`,{cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.success&&j.backendUrl){const backend=normalizeUrl(j.backendUrl);await chrome.storage.local.set({backend});return backend;}
  }catch(_){ }
  return normalizeUrl(data.backend)||BOOTSTRAP_BACKEND;
}
async function exchange(key,backend){
  const r=await fetch(`${backend}/api/auth/extension-key/exchange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extensionKey:key})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.success||!j.sessionToken) throw new Error(j.error||`Could not connect to ELMS (${r.status}).`);
  await chrome.storage.local.set({sessionToken:j.sessionToken,backend}); return j.sessionToken;
}
async function getSession(){
  const data=await chrome.storage.local.get(['extensionKey','sessionToken']);
  const key=String(data.extensionKey||'').trim(); if(!key) throw new Error('Connect your ELMS Extension Key first.');
  const backend=await resolveBackend(); return {key,backend,token:data.sessionToken||null};
}
async function importProduct(product,amazonUrl,markupPercent){
  let {key,backend,token}=await getSession(); if(!token) token=await exchange(key,backend);
  const send=async(authToken)=>fetch(`${backend}/api/browser-import`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify({amazonUrl,product,markupPercent})});
  let r=await send(token); if(r.status===401){token=await exchange(key,backend);r=await send(token);}
  const j=await r.json().catch(()=>({})); if(!r.ok||!j.success) throw new Error(j.error||`Import failed (${r.status}).`); return j;
}
chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message?.type!=='ELMS_IMPORT_PRODUCT') return false;
  importProduct(message.product,message.amazonUrl,message.markupPercent).then(result=>sendResponse({success:true,result})).catch(error=>sendResponse({success:false,error:error?.message||'Import failed.'}));
  return true;
});
