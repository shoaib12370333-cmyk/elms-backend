/**
 * One look for every ELMS mail: logo on top, the four-colour strip, the message, an optional button, a quiet footer.
 * Table based with inline styles (mail apps ignore most CSS). `preheader` is the grey preview text next to the subject.
 */
const COLORS = { red: '#E53238', blue: '#0064D2', yellow: '#F5AF02', green: '#86B817' };

const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function siteUrl(path) {
  const base = String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/$/, '');
  return base + (path || '');
}

function appName() {
  return process.env.APP_NAME || 'ELMS';
}

function paragraphsHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => '<p style="margin:0 0 14px;line-height:1.6;font-size:15px;color:#374151">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

function button(text, url) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="background:' + COLORS.blue + ';border-radius:8px"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">' + esc(text) + '</a></td></tr></table>';
}

const strip = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
  + [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.green].map((c) => '<td height="4" style="height:4px;line-height:4px;font-size:0;background:' + c + '">&nbsp;</td>').join('')
  + '</tr></table>';

/**
 * @param {object} o
 * @param {string} o.title      big heading in the mail
 * @param {string} o.bodyHtml   the message (already safe HTML)
 * @param {string} [o.preheader]
 * @param {{text:string,url:string}} [o.cta]
 * @param {string} [o.footerHtml] extra small print (already safe HTML), e.g. an unsubscribe link
 */
function layout({ title, bodyHtml, preheader = '', cta = null, footerHtml = '' }) {
  const name = appName();
  const logo = siteUrl('/logo-wordmark.png');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f3f5f9">'
    + (preheader ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' + esc(preheader) + '</div>' : '')
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">'
    + '<tr><td style="padding:22px 28px 18px"><a href="' + esc(siteUrl('/')) + '" style="text-decoration:none"><img src="' + esc(logo) + '" width="128" alt="' + esc(name) + '" style="display:block;border:0;height:auto;font-size:26px;font-weight:bold;letter-spacing:2px;color:' + COLORS.blue + '"></a></td></tr>'
    + '<tr><td>' + strip + '</td></tr>'
    + '<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827">' + esc(title) + '</h1>' + bodyHtml + (cta ? button(cta.text, cta.url) : '') + '</td></tr>'
    + '<tr><td style="padding:18px 28px 26px;border-top:1px solid #eef0f4;font-size:12px;line-height:1.6;color:#9ca3af">'
    + esc(name) + ' &middot; eBay Listing &amp; Management System<br><a href="' + esc(siteUrl('/')) + '" style="color:#9ca3af">elmstool.com</a>' + footerHtml
    + '</td></tr></table></td></tr></table></body></html>';
}

module.exports = { layout, paragraphsHtml, button, esc, siteUrl, COLORS };
