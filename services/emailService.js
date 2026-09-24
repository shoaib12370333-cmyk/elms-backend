const nodemailer = require('nodemailer');

let transporters = new Map();

// Sender identities. Each falls back to SMTP_FROM (then SMTP_USER) when its own
// variable is not set, so nothing breaks before the extra mailboxes exist.
//   noreply  - automatic mails (password reset OTP, welcome)
//   support  - help mails; also the Reply-To of every automatic mail
//   billing  - receipts, payment problems, refunds
//   security - login / password / device alerts
//   admin    - mails to the owner
const SENDERS = {
  noreply: { env: 'SMTP_FROM', label: '' },
  support: { env: 'SMTP_FROM_SUPPORT', label: 'Support' },
  billing: { env: 'SMTP_FROM_BILLING', label: 'Billing' },
  security: { env: 'SMTP_FROM_SECURITY', label: 'Security' },
  admin: { env: 'SMTP_FROM_ADMIN', label: '' },
};

// Each identity can have its own mailbox login: SMTP_USER_SUPPORT / SMTP_PASS_SUPPORT, SMTP_USER_BILLING /
// SMTP_PASS_BILLING, ... (noreply uses SMTP_USER / SMTP_PASS). Without its own login, an identity sends through
// the default login (which may need the address to be an alias in the mail provider).
function credentialsFor(kind) {
  const suffix = String(kind || 'noreply').toUpperCase();
  if (kind && kind !== 'noreply') {
    const user = String(process.env['SMTP_USER_' + suffix] || '').trim();
    const pass = process.env['SMTP_PASS_' + suffix];
    if (user && pass) return { user, pass, own: true, id: kind };
  }
  return { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, own: false, id: 'default' };
}

function senderAddress(kind) {
  const def = SENDERS[kind] || SENDERS.noreply;
  const own = credentialsFor(kind);
  if (own.own) return String(process.env[def.env] || own.user).trim();
  return String(process.env[def.env] || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

function fromHeader(kind) {
  const appName = process.env.APP_NAME || 'ELMS';
  const def = SENDERS[kind] || SENDERS.noreply;
  const name = def.label ? appName + ' ' + def.label : appName;
  return '"' + name + '" <' + senderAddress(kind) + '>';
}

// Automatic mails should send replies to support, unless support is the sender.
function replyToFor(kind) {
  if (kind === 'support') return undefined;
  const hasSupport = process.env.SMTP_FROM_SUPPORT || credentialsFor('support').own;
  const support = hasSupport ? senderAddress('support') : '';
  return support && support !== senderAddress(kind) ? support : undefined;
}

function withSender(message, kind) {
  const out = Object.assign({}, message, { from: fromHeader(kind) });
  const replyTo = replyToFor(kind);
  if (replyTo) out.replyTo = replyTo;
  return out;
}

function buildTransporter(port, kind) {
  const host = process.env.SMTP_HOST;
  const { user, pass } = credentialsFor(kind);
  if (!host || !user || !pass || /^your-email-password$/i.test(String(pass).trim())) {
    const err = new Error('Password reset email is not configured. Please contact support.');
    err.statusCode = 503;
    throw err;
  }

  const numericPort = Number(port);
  const secureEnv = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  // The port decides the mode: 465 is implicit TLS, 587 is STARTTLS. A mismatched SMTP_SECURE (e.g. false on 465,
  // true on 587) causes 'wrong version number', so it is only used for non-standard ports.
  const secure = numericPort === 465 ? true : numericPort === 587 ? false : secureEnv === 'true';
  return nodemailer.createTransport({
    host,
    port: numericPort,
    secure,
    requireTLS: !secure && numericPort === 587,
    auth: { user, pass },
    tls: { minVersion: 'TLSv1.2', servername: host },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    dnsTimeout: 5000,
  });
}

function getTransporter(port, kind) {
  const key = credentialsFor(kind).id + ':' + String(port);
  if (!transporters.has(key)) transporters.set(key, buildTransporter(port, kind));
  return transporters.get(key);
}

function isSenderRejected(err) {
  return /sender address rejected|not owned by user|not authorized to send|send as denied|553/i.test(String((err && (err.response || err.message)) || ''));
}

function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

// Sends one message. If the provider refuses the From address because the SMTP login does not own it
// (alias not set up), it is sent again from the login address itself, with the wanted address as Reply-To,
// so the mail still arrives and replies still reach the right mailbox.
async function sendWithTimeout(tx, message, timeoutMs = 20000, loginUser) {
  const attempt = (msg) => Promise.race([
    tx.sendMail(msg),
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error('SMTP send timed out.');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs)),
  ]);
  try {
    return await attempt(message);
  } catch (err) {
    const login = String(loginUser || process.env.SMTP_USER || '').trim();
    const wanted = addressOf(message.from);
    if (!isSenderRejected(err) || !login || !wanted || wanted === login.toLowerCase()) throw err;
    const nameMatch = String(message.from || '').match(/^\s*"?([^"<]*)"?\s*</);
    const name = nameMatch && nameMatch[1].trim();
    console.warn('SMTP refused sender ' + wanted + ' (not owned by ' + login + '). Resending from the login address; add ' + wanted + ' as an alias in your mail provider.');
    const retry = Object.assign({}, message, {
      from: name ? '"' + name + '" <' + login + '>' : login,
      replyTo: message.replyTo || wanted,
    });
    return attempt(retry);
  }
}

async function sendPasswordResetOtp({ to, code }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const message = {
    ...withSender({}, 'noreply'),
    to,
    subject: `${appName} password reset code`,
    text: `Your ${appName} password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>${appName} password reset</h2><p>Your verification code is:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px 0">${code}</div><p>This code expires in <strong>10 minutes</strong>. If you did not request a password reset, you can safely ignore this email.</p></div>`,
  };

  const configuredPort = Number(process.env.SMTP_PORT || 587);
  // Namecheap Private Email supports both submission modes. Try the configured
  // port first, then the alternate secure submission port when using 587/465.
  const ports = configuredPort === 587 ? [587, 465] : configuredPort === 465 ? [465, 587] : [configuredPort];
  let lastError;

  // Do the actual send instead of calling SMTP verify() first. Some SMTP
  // providers accept authenticated mail submission while their EHLO/verify
  // response behaves differently. The send itself is the real test.
  for (const port of ports) {
    try {
      const info = await sendWithTimeout(getTransporter(port, 'noreply'), message, 20000, credentialsFor('noreply').user);
      console.log(`Password-reset email accepted by SMTP on port ${port}: ${info.messageId || 'message accepted'} -> ${to}`);
      return info;
    } catch (err) {
      lastError = err;
      console.error(`Password-reset SMTP send failed on port ${port}:`, err.message);
    }
  }

  throw lastError || new Error('SMTP send failed.');
}

// Kept for compatibility with existing imports. The reset route no longer
// blocks the actual email send behind verify(); sendPasswordResetOtp performs
// the real SMTP operation and has a 587 -> 465 fallback.
async function verifyEmailTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const tx = getTransporter(port);
  return tx.verify();
}


const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Sends one prepared message from the given identity, trying the configured port then the alternate one.
async function sendFrom(kind, message, label) {
  const configuredPort = Number(process.env.SMTP_PORT || 587);
  const ports = configuredPort === 587 ? [587, 465] : configuredPort === 465 ? [465, 587] : [configuredPort];
  const full = withSender(message, kind);
  let lastError;
  for (const port of ports) {
    try {
      const info = await sendWithTimeout(getTransporter(port, kind), full, 20000, credentialsFor(kind).user);
      console.log(label + ' email accepted by SMTP on port ' + port + ' -> ' + full.to);
      return info;
    } catch (err) {
      lastError = err;
      console.error(label + ' SMTP send failed on port ' + port + ':', err.message);
    }
  }
  throw lastError || new Error('SMTP send failed.');
}

function frontendUrl(path) {
  const base = String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/$/, '');
  return base + (path || '');
}

function wrapHtml(title, bodyHtml, footerHtml) {
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937"><h2 style="margin:0 0 14px">' + esc(title) + '</h2>' + bodyHtml + (footerHtml || '') + '</div>';
}

function paragraphsHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => '<p style="margin:0 0 14px;line-height:1.55">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

async function sendPurchaseReceiptEmail({ to, credits, priceUsd, transactionId, when }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const lines = [
    'Thank you for your purchase.',
    'Credits added: ' + Number(credits).toLocaleString('en-US'),
    'Amount paid: $' + Number(priceUsd || 0).toFixed(2),
    'Date: ' + new Date(when || Date.now()).toUTCString(),
    'Reference: ' + transactionId,
    'Your credits are available in your account now. Payments are processed by Paddle, who will also send you their own receipt.',
    'Questions about this payment? Reply to this email.',
  ];
  return sendFrom('billing', {
    to,
    subject: appName + ' receipt: ' + Number(credits).toLocaleString('en-US') + ' credits',
    text: lines.join('\n\n'),
    html: wrapHtml(appName + ' receipt', paragraphsHtml(lines.join('\n\n'))),
  }, 'Receipt');
}

// ref: the ticket's short code, put in the subject so the customer's answer finds its ticket again.
// inReplyTo: Message-ID of the mail that opened the ticket, so mail apps keep it in one conversation.
// ai: the reply was written by the support assistant; holding: it only says a person will look at the ticket;
// viaEmail: the customer can answer by replying to this mail (otherwise they are pointed to a new ticket).
/** Tells a user an admin gave them a voucher. */
async function sendVoucherEmail({ to, what, note, expiresAt, redeem }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const lines = [
    'You have a new voucher: ' + what + '.',
    note ? note : null,
    expiresAt ? 'It is valid until ' + new Date(expiresAt).toUTCString().slice(0, 16) + '.' : null,
    redeem ? 'Open Vouchers in ' + appName + ' and press Redeem to use it.' : 'Choose it on the Buy credits page to take it off the price.',
    frontendUrl('/vouchers'),
  ].filter(Boolean);
  return sendFrom('billing', {
    to,
    subject: appName + ': you have a new voucher',
    text: lines.join('\n\n'),
    html: wrapHtml('You have a new voucher', paragraphsHtml(lines.join('\n\n'))),
  }, 'Voucher');
}

async function sendTicketReplyEmail({ to, subject, reply, ref, inReplyTo, ai = false, holding = false, viaEmail = true }) {
  const appName = process.env.APP_NAME || 'ELMS';
  let text;
  if (holding) text = reply + '\n\n- ' + appName + ' Support';
  else if (ai) text = 'Here is the answer to your support request "' + subject + '":\n\n' + reply + '\n\n- ' + appName + ' AI assistant. ' + (viaEmail ? 'If this does not solve it, reply to this email and our team will step in.' : 'If this does not solve it, open a new ticket and write "talk to admin".');
  else text = 'Your support request "' + subject + '" has been answered:\n\n' + reply + '\n\nYou can reply to this email if you need more help.';
  return sendFrom('support', {
    to,
    subject: 'Re: ' + subject + (ref ? ' [Ticket #' + ref + ']' : ''),
    text,
    html: wrapHtml(appName + ' Support', paragraphsHtml(text)),
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  }, 'Ticket reply');
}

// Alert to the owner. Goes to ADMIN_ALERT_EMAIL, or to the admin sender address itself.
async function sendAdminAlert({ subject, lines }) {
  const to = String(process.env.ADMIN_ALERT_EMAIL || senderAddress('admin') || '').trim();
  if (!to) return null;
  const appName = process.env.APP_NAME || 'ELMS';
  const text = lines.join('\n');
  return sendFrom('admin', {
    to,
    subject: '[' + appName + '] ' + subject,
    text,
    html: wrapHtml(subject, paragraphsHtml(text)),
  }, 'Admin alert');
}

async function sendAnnouncementEmail({ to, subject, body, unsubscribeUrl, listUnsubscribe = true }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const footerText = '\n\n--\nYou get this because you have an ' + appName + ' account. Unsubscribe: ' + unsubscribeUrl;
  const footerHtml = '<p style="margin-top:28px;font-size:12px;color:#6b7280">You get this because you have an ' + esc(appName) + ' account. <a href="' + esc(unsubscribeUrl) + '">Unsubscribe</a></p>';
  const message = {
    to,
    subject,
    text: body + footerText,
    html: wrapHtml(subject, paragraphsHtml(body), footerHtml),
  };
  if (listUnsubscribe) message.headers = { 'List-Unsubscribe': '<' + unsubscribeUrl + '>' };
  return sendFrom('support', message, 'Announcement');
}

function buildSecurityMessage({ to, subject, title, paragraphs, kind = 'security' }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const safe = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlParagraphs = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.55">${safe(p)}</p>`).join('');
  return {
    ...withSender({}, kind),
    to,
    subject,
    text: `${title}\n\n${paragraphs.join('\n\n')}\n\nRegards,\n${appName} Support Team`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937"><h2>${safe(title)}</h2>${htmlParagraphs}<p style="margin-top:24px">Regards,<br><strong>${safe(appName)} Support Team</strong></p></div>`,
  };
}

async function sendSecurityEmail({ to, subject, title, paragraphs, kind }) {
  const message = buildSecurityMessage({ to, subject, title, paragraphs, kind });
  const configuredPort = Number(process.env.SMTP_PORT || 465);
  const ports = configuredPort === 587 ? [587, 465] : configuredPort === 465 ? [465, 587] : [configuredPort];
  let lastError;
  for (const port of ports) {
    try {
      const info = await sendWithTimeout(getTransporter(port, kind || 'security'), message, 20000, credentialsFor(kind || 'security').user);
      console.log(`Security email accepted by SMTP on port ${port}: ${info.messageId || 'message accepted'} -> ${to}`);
      return info;
    } catch (err) {
      lastError = err;
      console.error(`Security SMTP send failed on port ${port}:`, err.message);
    }
  }
  throw lastError || new Error('SMTP send failed.');
}

async function sendPasswordChangedEmail({ to }) {
  const appName = process.env.APP_NAME || 'ELMS';
  return sendSecurityEmail({
    to,
    subject: `${appName} password changed`,
    title: `Your ${appName} account password was successfully changed`,
    paragraphs: [
      'If you made this change, no further action is required.',
      'If you did not make this change, please contact ELMS Support immediately to secure your account.',
      'For your security, never share your password or verification codes with anyone.',
    ],
  });
}

async function sendPasswordResetRequestedEmail({ to }) {
  const appName = process.env.APP_NAME || 'ELMS';
  return sendSecurityEmail({
    to,
    subject: `${appName} password reset request`,
    title: `A password reset request was made for your ${appName} account`,
    paragraphs: [
      'If you requested this password reset, please follow the verification instructions provided to create a new password.',
      'If you did not request this change, you can safely ignore this message. If you believe your account may be at risk, please contact ELMS Support.',
    ],
  });
}

async function sendNewLoginEmail({ to, method }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const loginMethod = method === 'google' ? 'Google' : 'email and password';
  return sendSecurityEmail({
    to,
    subject: `New login detected on your ${appName} account`,
    title: `A new login to your ${appName} account was detected`,
    paragraphs: [
      `A new login using ${loginMethod} was detected on your account.`,
      'If this was you, no further action is required.',
      'If you do not recognize this login, please contact ELMS Support immediately and consider changing your password to protect your account.',
      'For your security, never share your password or verification codes with anyone.',
    ],
  });
}

async function sendNewDeviceEmail({ to, device, where, method, when }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const loginMethod = method === 'google' ? 'Google' : 'email and password';
  const frontend = process.env.FRONTEND_URL || '';
  return sendSecurityEmail({
    to,
    subject: `New device signed in to your ${appName} account`,
    title: `Someone signed in to your ${appName} account from a new device`,
    paragraphs: [
      `Device: ${device}`,
      `Location: ${where} (approximate, from the IP address)`,
      `Time: ${new Date(when).toUTCString()}`,
      `Sign-in method: ${loginMethod}`,
      'If this was you, no action is needed.',
      `If it was not you: open ${frontend ? frontend.replace(/\/$/, '') + '/settings' : 'ELMS'} \u2192 Security, press "Log out everywhere", then change your password.`,
      'You can turn these emails off in Settings \u2192 Security.',
    ],
  });
}

module.exports = { credentialsFor, frontendUrl, sendVoucherEmail, sendPurchaseReceiptEmail, sendTicketReplyEmail, sendAdminAlert, sendAnnouncementEmail, senderAddress, fromHeader, replyToFor, sendSecurityEmail, sendNewDeviceEmail, sendPasswordResetOtp, sendPasswordChangedEmail, sendPasswordResetRequestedEmail, sendNewLoginEmail, verifyEmailTransport };
