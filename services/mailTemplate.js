/**
 * One look for every ELMS mail: logo on top, the four-colour strip, an optional status banner, the message, an optional details box
 * and button, and a footer that always carries the Privacy Policy and Terms links.
 * Table based with inline styles (mail apps ignore most CSS). `preheader` is the grey preview text next to the subject.
 * Every mail leaves through emailService.sendWithTimeout, which calls ensureLayout(), so a mail written without this layout
 * still gets it (and the plain-text version gets the same legal lines).
 */
const COLORS = { red: '#E53238', blue: '#0064D2', yellow: '#F5AF02', green: '#86B817' };

// Status banner colours: text, background, border.
const TONES = {
  red: { fg: '#B42318', bg: '#FEF3F2', line: '#FECDCA' },
  amber: { fg: '#B54708', bg: '#FFFAEB', line: '#FEDF89' },
  green: { fg: '#067647', bg: '#ECFDF3', line: '#ABEFC6' },
  blue: { fg: '#175CD3', bg: '#EFF8FF', line: '#B2DDFF' },
};

const LAYOUT_MARK = 'data-elms-layout="1"';

const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function siteUrl(path) {
  const base = String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/$/, '');
  return base + (path || '');
}

function appName() {
  return process.env.APP_NAME || 'ELMS';
}

/** The legal pages every mail points to. */
function legalLinks() {
  return [
    { text: 'Privacy Policy', url: siteUrl('/policy.html') },
    { text: 'Terms of Service', url: siteUrl('/terms.html') },
    { text: 'User Guide', url: siteUrl('/user-guide.html') },
  ];
}

function paragraphsHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => '<p style="margin:0 0 14px;line-height:1.6;font-size:15px;color:#374151">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

function button(text, url) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="background:' + COLORS.blue + ';border-radius:8px"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">' + esc(text) + '</a></td></tr></table>';
}

/** A small table of facts, e.g. [['Account', 'a@b.com'], ['Reason', '...']]. Rows with an empty value are left out. */
function detailsTable(rows) {
  const shown = (rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== '');
  if (!shown.length) return '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px">'
    + shown.map((r, i) => '<tr><td style="padding:10px 14px;width:34%;vertical-align:top;font-size:13px;color:#6b7280' + (i ? ';border-top:1px solid #eef0f4' : '') + '">' + esc(r[0]) + '</td>'
      + '<td style="padding:10px 14px;vertical-align:top;font-size:14px;line-height:1.5;color:#111827' + (i ? ';border-top:1px solid #eef0f4' : '') + '">' + esc(r[1]).replace(/\n/g, '<br>') + '</td></tr>').join('')
    + '</table>';
}

/** A quoted message from the team (written by an admin: escaped, line breaks kept). */
function quote(label, text) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="padding:12px 16px;background:#f3f5f9;border-left:4px solid ' + COLORS.blue + ';border-radius:6px;font-size:14px;line-height:1.6;color:#1f2937">'
    + (label ? '<div style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color:#6b7280">' + esc(label) + '</div>' : '')
    + esc(text).replace(/\n/g, '<br>') + '</td></tr></table>';
}

/** A short heading with a numbered or bulleted list under it, e.g. "What this means". */
function steps(heading, items, { ordered = false } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return (heading ? '<h2 style="margin:20px 0 8px;font-size:16px;line-height:1.3;color:#111827">' + esc(heading) + '</h2>' : '')
    + '<' + tag + ' style="margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.6;color:#374151">'
    + list.map((item) => '<li style="margin:0 0 6px">' + esc(item) + '</li>').join('') + '</' + tag + '>';
}

const strip = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
  + [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.green].map((c) => '<td height="4" style="height:4px;line-height:4px;font-size:0;background:' + c + '">&nbsp;</td>').join('')
  + '</tr></table>';

function bannerRow(banner) {
  if (!banner || !banner.label) return '';
  const tone = TONES[banner.tone] || TONES.blue;
  return '<tr><td style="padding:11px 28px;background:' + tone.bg + ';border-bottom:1px solid ' + tone.line + ';font-size:12px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:' + tone.fg + '">' + esc(banner.label) + '</td></tr>';
}

/** The footer every mail carries: who we are, the legal links, why the person got the mail, a safety reminder. */
function footerHtml(extraHtml) {
  const name = appName();
  const links = legalLinks().map((l) => '<a href="' + esc(l.url) + '" style="color:#4b5563;text-decoration:underline">' + esc(l.text) + '</a>').join(' &nbsp;&middot;&nbsp; ');
  return '<tr><td style="padding:20px 28px 26px;background:#f9fafb;border-top:1px solid #eef0f4;font-size:12px;line-height:1.7;color:#9ca3af">'
    + '<div style="font-size:13px;font-weight:bold;color:#6b7280">' + esc(name) + ' &middot; eBay Listing &amp; Management System</div>'
    + '<div style="margin:6px 0 10px">' + links + '</div>'
    + '<div>You are receiving this email because of activity on an ' + esc(name) + ' account, or a request made with this email address. Service emails like this one are sent even if you have turned off news and offers.</div>'
    + '<div style="margin-top:8px">' + esc(name) + ' will never ask for your password by email. Never share your password or a verification code with anyone.</div>'
    + (extraHtml || '')
    + '<div style="margin-top:12px"><a href="' + esc(siteUrl('/')) + '" style="color:#9ca3af">elmstool.com</a> &middot; &copy; ' + new Date().getFullYear() + ' ' + esc(name) + '</div>'
    + '</td></tr>';
}

/** The same legal lines for the plain-text version of a mail. */
function textFooter() {
  const lines = legalLinks().map((l) => l.text + ': ' + l.url);
  return '--\n' + appName() + ' - eBay Listing & Management System\n' + lines.join('\n');
}

/**
 * @param {object} o
 * @param {string} o.title      big heading in the mail
 * @param {string} o.bodyHtml   the message (already safe HTML)
 * @param {string} [o.preheader]
 * @param {{text:string,url:string}} [o.cta]
 * @param {{label:string,tone?:'red'|'amber'|'green'|'blue'}} [o.banner] coloured status line above the heading
 * @param {string} [o.footerHtml] extra small print (already safe HTML), e.g. an unsubscribe link
 */
function layout({ title, bodyHtml, preheader = '', cta = null, banner = null, footerHtml: extraFooter = '' }) {
  const name = appName();
  const logo = siteUrl('/logo-wordmark.png');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f3f5f9">'
    + (preheader ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' + esc(preheader) + '</div>' : '')
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" ' + LAYOUT_MARK + ' width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">'
    + '<tr><td style="padding:22px 28px 18px"><a href="' + esc(siteUrl('/')) + '" style="text-decoration:none"><img src="' + esc(logo) + '" width="128" alt="' + esc(name) + '" style="display:block;border:0;height:auto;font-size:26px;font-weight:bold;letter-spacing:2px;color:' + COLORS.blue + '"></a></td></tr>'
    + '<tr><td>' + strip + '</td></tr>'
    + bannerRow(banner)
    + '<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827">' + esc(title) + '</h1>' + bodyHtml + (cta ? button(cta.text, cta.url) : '') + '</td></tr>'
    + footerHtml(extraFooter)
    + '</table></td></tr></table></body></html>';
}

/**
 * Makes sure one outgoing message has the ELMS layout and the legal lines. A mail built with layout() is left as it is; a mail with no
 * HTML (or a bare HTML fragment) is wrapped; the text version gets the Privacy / Terms lines once. Returns a new message.
 */
function ensureLayout(message) {
  const out = Object.assign({}, message);
  const text = String(out.text || '');
  const html = String(out.html || '');
  if (!html.includes(LAYOUT_MARK)) {
    const title = String(out.subject || appName());
    // A bare fragment is put inside the layout as it is; a whole foreign document (or nothing) is rebuilt from the plain text.
    const fragment = html && !/<html[\s>]/i.test(html);
    out.html = layout({ title, bodyHtml: fragment ? html : paragraphsHtml(text || html.replace(/<[^>]+>/g, ' ')) });
  }
  if (!/Privacy Policy: https?:\/\//.test(text)) out.text = (text ? text.replace(/\s+$/, '') + '\n\n' : '') + textFooter();
  return out;
}

module.exports = { layout, paragraphsHtml, button, detailsTable, quote, steps, esc, siteUrl, legalLinks, textFooter, ensureLayout, COLORS, LAYOUT_MARK };
