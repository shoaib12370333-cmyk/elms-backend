const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { saveLocalImage, rootDir } = require('./imageStorageService');

const MAX_PDF_BYTES = 5 * 1024 * 1024;

function publicBaseUrl(req) {
  return String(process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function cleanName(name, fallback) {
  const base = String(name || '').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80);
  return base || fallback;
}

/**
 * Stores one buyer-message attachment (a JPG/PNG/WEBP/GIF image or a PDF, sent as a data URL) on
 * ELMS's own public storage and returns what eBay's send_message needs: eBay only accepts
 * self-hosted HTTPS media URLs, so the file must be reachable from the internet.
 * @returns {Promise<{ name: string, type: 'IMAGE'|'PDF', url: string }>}
 */
async function saveMessageAttachment({ dataUrl, name, userId, req }) {
  const raw = String(dataUrl || '');
  if (/^data:image\//i.test(raw)) {
    const saved = await saveLocalImage({ dataUrl: raw, userId, listingId: 'messages', req });
    return { name: cleanName(name, saved.filename), type: 'IMAGE', url: saved.url };
  }
  const m = raw.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw Object.assign(new Error('Only images (JPG, PNG, WEBP, GIF) and PDF files can be attached.'), { statusCode: 400 });
  const buffer = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.subarray(0, 4).toString('ascii') !== '%PDF') throw Object.assign(new Error('That file is not a valid PDF.'), { statusCode: 400 });
  if (buffer.length > MAX_PDF_BYTES) throw Object.assign(new Error('PDF files must be 5MB or smaller.'), { statusCode: 400 });

  const safe = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'unknown';
  const dir = path.join(rootDir(), safe(userId), 'messages');
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${crypto.createHash('sha256').update(buffer).digest('hex')}.pdf`;
  try { await fs.promises.writeFile(path.join(dir, filename), buffer, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return { name: cleanName(name, filename), type: 'PDF', url: `${publicBaseUrl(req)}/uploads/listing-images/${encodeURIComponent(String(userId))}/messages/${filename}` };
}

/** Keeps only attachments this server itself produced (HTTPS, known type), max 5 - the client is not trusted. */
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && /^https:\/\//i.test(String(x.url || '')) && ['IMAGE', 'PDF'].includes(String(x.type)) && String(x.url).includes('/uploads/listing-images/'))
    .slice(0, 5)
    .map((x) => ({ name: cleanName(x.name, 'attachment'), type: String(x.type), url: String(x.url) }));
}

module.exports = { saveMessageAttachment, sanitizeAttachments };
