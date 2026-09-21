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

function senderAddress(kind) {
  const def = SENDERS[kind] || SENDERS.noreply;
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
  const support = String(process.env.SMTP_FROM_SUPPORT || '').trim();
  return support && support !== senderAddress(kind) ? support : undefined;
}

function withSender(message, kind) {
  const out = Object.assign({}, message, { from: fromHeader(kind) });
  const replyTo = replyToFor(kind);
  if (replyTo) out.replyTo = replyTo;
  return out;
}

function buildTransporter(port) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass || /^your-email-password$/i.test(String(pass).trim())) {
    const err = new Error('Password reset email is not configured. Please contact support.');
    err.statusCode = 503;
    throw err;
  }

  const numericPort = Number(port);
  const secureEnv = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv ? secureEnv === 'true' : numericPort === 465;
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

function getTransporter(port) {
  const key = String(port);
  if (!transporters.has(key)) transporters.set(key, buildTransporter(port));
  return transporters.get(key);
}

async function sendWithTimeout(tx, message, timeoutMs = 20000) {
  return Promise.race([
    tx.sendMail(message),
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error('SMTP send timed out.');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs)),
  ]);
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
      const info = await sendWithTimeout(getTransporter(port), message);
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
      const info = await sendWithTimeout(getTransporter(port), message);
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

module.exports = { senderAddress, fromHeader, replyToFor, sendSecurityEmail, sendNewDeviceEmail, sendPasswordResetOtp, sendPasswordChangedEmail, sendPasswordResetRequestedEmail, sendNewLoginEmail, verifyEmailTransport };
