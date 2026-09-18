const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const dns = require('dns').promises;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 24;
const ALLOWED = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};

function rootDir() {
  return process.env.LISTING_IMAGE_DIR
    ? path.resolve(process.env.LISTING_IMAGE_DIR)
    : path.join(__dirname, '..', 'uploads', 'listing-images');
}
function publicBaseUrl(req) {
  return String(process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
function safePathSegment(value) {
  const raw = String(value || '');
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return clean || 'unknown';
}

function extFromType(type) {
  return ALLOWED[String(type || '').split(';')[0].trim().toLowerCase()] || null;
}

function hasImageSignature(buffer, ext) {
  if (!buffer || buffer.length < 12) return false;
  if (ext === 'jpg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'png') return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === 'gif') return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === 'webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function isPrivateIpv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function isPrivateIpv6(ip) {
  const v = String(ip).toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
}
async function assertSafeRemoteUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Image address must use HTTP or HTTPS.');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private/local image addresses are not allowed.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(({address}) => isPrivateIpv4(address) || isPrivateIpv6(address))) {
    throw new Error('Private/local image addresses are not allowed.');
  }
  return parsed.toString();
}

function extFromUrl(url) {
  const m = new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
  return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : null;
}
async function writeActual({buffer, ext, userId, listingId, req}) {
  if (!buffer?.length) throw new Error('Image file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Each image must be 10MB or smaller.');
  if (!hasImageSignature(buffer, ext)) throw new Error('The uploaded data is not a valid JPG, PNG, WEBP, or GIF image.');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(rootDir(), safePathSegment(userId), safePathSegment(listingId));
  await fs.promises.mkdir(dir, {recursive:true});
  const filename = `${hash}.${ext}`;
  const filePath = path.join(dir, filename);
  try { await fs.promises.writeFile(filePath, buffer, {flag:'wx'}); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return {
    url: `${publicBaseUrl(req)}/uploads/listing-images/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(listingId))}/${filename}`,
    filename, filePath, bytes: buffer.length
  };
}
function parseDataImage(dataUrl) {
  const m=String(dataUrl||'').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw new Error('Only JPG, PNG, WEBP, or GIF images are supported.');
  const ext=ALLOWED[m[1].toLowerCase()];
  const buffer=Buffer.from(m[2].replace(/\s/g,''),'base64');
  if (!buffer.length) throw new Error('The image data is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Each image must be 10MB or smaller.');
  return {buffer,ext};
}
async function saveLocalImage(args) {
  const {buffer,ext}=parseDataImage(args.dataUrl);
  return writeActual({...args,buffer,ext});
}
async function downloadAndSaveImage({imageUrl,userId,listingId,req}) {
  let url=String(imageUrl||'').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Image address must start with http:// or https://.');
  url = await assertSafeRemoteUrl(url);
  // Amazon's image CDN (m.media-amazon.com) sometimes 301/302-redirects and
  // rejects non-browser User-Agents with a 403. Allowing a couple of redirects
  // and sending a normal browser UA lets these downloads succeed - otherwise
  // every image fails to import, which later makes the eBay publish fail with
  // "could not import any of the product images".
  const r=await axios.get(url,{
    responseType:'arraybuffer', timeout:20000, maxContentLength:MAX_FILE_BYTES,
    maxBodyLength:MAX_FILE_BYTES, maxRedirects:3, validateStatus:s=>s>=200&&s<300,
    headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    }
  });
  const buffer=Buffer.from(r.data);
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Image is larger than 10MB.');
  const ext=extFromType(r.headers['content-type']) || extFromUrl(url);
  if (!ext) throw new Error('URL did not return a supported image (JPG, PNG, WEBP, or GIF).');
  return writeActual({buffer,ext,userId,listingId,req});
}
/**
 * Amazon image URLs often carry a size/crop suffix (e.g. "._AC_SL160_." or
 * "._SX300_.") that yields a small/thumbnail image. Stripping that suffix
 * returns the full-resolution original, so eBay listings get the highest
 * quality image available. Non-Amazon URLs are returned unchanged.
 */
function toHighResAmazonUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/(?:media-amazon|images-amazon|ssl-images-amazon)\.com/i.test(url)) return url;
  // The size/crop suffix sits between the last two dots, e.g. "._AC_SL1500_.jpg"
  // or "._SX300_SY300_QL70_.jpg". Removing it yields the full-resolution original.
  return url.replace(/\._[A-Za-z0-9,_-]+_\.(jpg|jpeg|png|webp|gif)$/i, '.$1');
}

async function materializeImageUrls({urls,userId,listingId,req,concurrency=4}) {
  const unique = [...new Set((Array.isArray(urls) ? urls : []).map((u) => toHighResAmazonUrl(String(u || '').trim())).filter(Boolean))].slice(0, MAX_IMAGES);
  const out = [];
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    // Use allSettled so one bad/blocked image doesn't fail the whole import -
    // we keep every image that downloads successfully and just skip the rest.
    const results = await Promise.allSettled(batch.map((imageUrl) => downloadAndSaveImage({imageUrl,userId,listingId,req})));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value?.url) out.push(r.value.url);
      else if (r.status === 'rejected') console.warn(`[image-import skipped] ${batch[idx]}: ${r.reason?.message || r.reason}`);
    });
  }
  return [...new Set(out)].slice(0, MAX_IMAGES);
}
module.exports={MAX_FILE_BYTES,MAX_IMAGES,rootDir,saveLocalImage,downloadAndSaveImage,materializeImageUrls};
