const nodemailer = require('nodemailer');

let transporters = new Map();

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
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || 'ELMS';
  const message = {
    from: `"${appName}" <${from}>`,
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

module.exports = { sendPasswordResetOtp, verifyEmailTransport };
