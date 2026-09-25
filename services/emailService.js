const nodemailer = require('nodemailer');
const mailTemplate = require('./mailTemplate');

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
    html: mailTemplate.layout({
      title: 'Your password reset code',
      preheader: 'Your code is ' + code + '. It expires in 10 minutes.',
      bodyHtml: mailTemplate.paragraphsHtml('Use this code to choose a new password:')
        + '<div style="margin:4px 0 18px;padding:16px;text-align:center;background:#f3f5f9;border-radius:10px;font-size:32px;font-weight:bold;letter-spacing:8px;color:#111827">' + mailTemplate.esc(code) + '</div>'
        + mailTemplate.paragraphsHtml('The code expires in 10 minutes. If you did not ask for a password reset, you can ignore this email. Your password stays as it is.'),
    }),
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

function wrapHtml(title, bodyHtml, footerHtml, opts = {}) {
  return mailTemplate.layout({ title, bodyHtml, footerHtml: footerHtml ? '<br><br>' + footerHtml : '', preheader: opts.preheader, cta: opts.cta });
}

const paragraphsHtml = mailTemplate.paragraphsHtml;

/** The 6-digit code that confirms the address at sign-up. No account exists yet: it is made when the code is entered. */
async function sendSignupCodeEmail({ to, code, minutes = 15 }) {
  const appName = process.env.APP_NAME || 'ELMS';
  return sendFrom('noreply', {
    to,
    subject: appName + ' confirmation code',
    text: 'Your ' + appName + ' confirmation code is ' + code + '. It expires in ' + minutes + ' minutes.\n\nEnter it on the sign-up page to finish creating your account. If you did not try to sign up, ignore this email: no account is created until the code is entered.',
    html: mailTemplate.layout({
      title: 'Confirm your email address',
      preheader: 'Your code is ' + code + '. It expires in ' + minutes + ' minutes.',
      bodyHtml: mailTemplate.paragraphsHtml('Enter this code on the sign-up page to finish creating your account:')
        + '<div style="margin:4px 0 18px;padding:16px;text-align:center;background:#f3f5f9;border-radius:10px;font-size:32px;font-weight:bold;letter-spacing:8px;color:#111827">' + mailTemplate.esc(code) + '</div>'
        + mailTemplate.paragraphsHtml('The code expires in ' + minutes + ' minutes. If you did not try to sign up, ignore this email: no account is created until the code is entered.'),
    }),
  }, 'Sign-up code');
}

/** The welcome mail for a brand-new account. `credits` is what the account was given at sign-up (0 = none). */
async function sendWelcomeEmail({ to, name, credits = 0 }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const n = Math.max(0, Math.floor(Number(credits) || 0));
  const first = String(name || '').trim().split(/\s+/)[0];
  const creditsText = n.toLocaleString('en-US') + ' free credit' + (n === 1 ? '' : 's');
  const lines = [
    first ? 'Hi ' + first + ',' : 'Hi,',
    'Welcome to ' + appName + '. Your account is ready.',
    n > 0 ? 'We added ' + creditsText + ' to your account so you can try ' + appName + ' straight away. Your balance is always shown at the top of the app.' : null,
    'Getting started takes three steps:\n1. Connect your eBay store in Settings.\n2. Paste an Amazon link on the Import page.\n3. Check the draft in Drafts and publish it to eBay.',
    'Questions? Open Support in the app and send us a ticket.',
  ].filter(Boolean);
  const url = frontendUrl('/dashboard');
  return sendFrom('noreply', {
    to,
    subject: n > 0 ? 'Welcome to ' + appName + ': ' + creditsText + ' to try it' : 'Welcome to ' + appName,
    text: lines.join('\n\n') + '\n\n' + url,
    html: wrapHtml('Welcome to ' + appName, paragraphsHtml(lines.join('\n\n')), '', {
      preheader: n > 0 ? creditsText + ' are in your account' : 'Your account is ready',
      cta: { text: 'Open ' + appName, url },
    }),
  }, 'Welcome');
}

/** Sends the invoice for a purchase. `purchase` (the recorded purchase) gives the full invoice with its PDF; without it a short receipt goes out. */
async function sendPurchaseReceiptEmail({ to, credits, priceUsd, transactionId, when, purchase }) {
  if (purchase) {
    const sent = await require('./invoiceService').sendInvoiceForPurchase(purchase);
    if (sent) return sent;
  }
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
    html: wrapHtml('Thanks for your purchase', paragraphsHtml(lines.join('\n\n')), '', { preheader: Number(credits).toLocaleString('en-US') + ' credits added' }),
  }, 'Receipt');
}

/** Tells a buyer their monthly / yearly plan has ended (credits ended with it). */
async function sendPlanEndedEmail({ to, planName, endedAt }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const what = planName ? 'Your ' + planName + ' plan' : 'Your plan';
  const day = new Date(endedAt || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const lines = [
    what + ' ended on ' + day + '. The credits that came with it have ended too, and your eBay account limit is back to what it was before the plan.',
    'Your listings, drafts and orders are all still there. Choose a plan again whenever you are ready and everything works as before.',
  ];
  return sendFrom('billing', {
    to,
    subject: appName + ': your plan has ended',
    text: lines.join('\n\n') + '\n\n' + frontendUrl('/pricing'),
    html: wrapHtml('Your plan has ended', paragraphsHtml(lines.join('\n\n')), '', { preheader: what + ' ended on ' + day, cta: { text: 'Choose a plan', url: frontendUrl('/pricing') } }),
  }, 'Plan ended');
}

/** Tells a user whether their affiliate application was approved. */
async function sendAffiliateDecisionEmail({ to, approved, link, percent, note }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const lines = approved
    ? [
      'Your affiliate application was approved. You now earn ' + percent + '% of every payment made by people who sign up through your link, for as long as they keep paying.',
      'Your link: ' + link,
      'Commissions are held for a few days, then you can ask for a payout in USDT or USDC from the Affiliate page. Payouts are sent within 24 to 48 hours.',
    ]
    : ['Your affiliate application was not approved this time.'];
  if (note) lines.push('Note from the team: ' + note);
  return sendFrom('support', {
    to,
    subject: appName + ' affiliate: ' + (approved ? 'you are approved' : 'about your application'),
    text: lines.join('\n\n'),
    html: wrapHtml(approved ? 'You are an ELMS affiliate' : 'Your affiliate application', paragraphsHtml(lines.join('\n\n')), '', approved ? { preheader: 'Your link is ready', cta: { text: 'Open your affiliate page', url: frontendUrl('/affiliate') } } : {}),
  }, 'Affiliate decision');
}

/** Tells an affiliate their payout was sent. */
async function sendAffiliatePaidEmail({ to, amountUsd, network, address, txHash }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const lines = [
    'Your affiliate payout of $' + Number(amountUsd).toFixed(2) + ' was sent.',
    'Network: ' + network,
    'To: ' + address,
    'Transaction: ' + txHash,
    'Thank you for promoting ' + appName + '.',
  ];
  return sendFrom('billing', {
    to,
    subject: appName + ' affiliate payout sent: $' + Number(amountUsd).toFixed(2),
    text: lines.join('\n\n'),
    html: wrapHtml('Your payout was sent', paragraphsHtml(lines.join('\n\n')), '', { preheader: '$' + Number(amountUsd).toFixed(2) + ' on ' + network, cta: { text: 'Open your affiliate page', url: frontendUrl('/affiliate') } }),
  }, 'Affiliate payout');
}

/** A prepared invoice mail (subject, text, html) with the PDF attached. */
async function sendInvoiceEmail({ to, subject, text, html, attachments }) {
  return sendFrom('billing', { to, subject, text, html, ...(attachments ? { attachments } : {}) }, 'Invoice');
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
    html: wrapHtml('You have a new voucher', paragraphsHtml(lines.slice(0, -1).join('\n\n')), '', {
      preheader: what,
      cta: { text: redeem ? 'Redeem voucher' : 'Buy credits', url: frontendUrl(redeem ? '/vouchers' : '/pricing') },
    }),
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

const SENDER_LABELS = { noreply: 'ELMS (no-reply)', support: 'Support', billing: 'Billing', security: 'Security', admin: 'Admin' };

/** A sender counts as set up when its own address or its own mailbox login is in the environment (noreply: SMTP_FROM or SMTP_USER). */
function senderConfigured(kind) {
  const def = SENDERS[kind];
  if (!def) return false;
  if (process.env[def.env]) return true;
  if (kind === 'noreply') return !!(process.env.SMTP_FROM || process.env.SMTP_USER);
  return credentialsFor(kind).own;
}

/** The senders the admin can choose from, with the real address each one sends as. Senders that are not set up are left out. */
function availableSenders() {
  return Object.keys(SENDERS)
    .filter((kind) => senderConfigured(kind) && senderAddress(kind))
    .map((kind) => ({ id: kind, label: SENDER_LABELS[kind] || kind, address: senderAddress(kind) }));
}

/** One mail written by the admin, to any address, from one of the configured senders. */
async function sendCustomMail({ from, to, subject, body }) {
  const kind = String(from || '');
  if (!availableSenders().some((s) => s.id === kind)) throw new Error('Choose one of the configured senders.');
  return sendFrom(kind, {
    to,
    subject,
    text: body,
    html: wrapHtml(subject, paragraphsHtml(body)),
  }, 'Admin mail');
}

async function sendAnnouncementEmail({ to, subject, body, unsubscribeUrl, listUnsubscribe = true, sender = 'support' }) {
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
  return sendFrom(SENDERS[sender] ? sender : 'support', message, 'Announcement');
}

function buildSecurityMessage({ to, subject, title, paragraphs, kind = 'security' }) {
  const appName = process.env.APP_NAME || 'ELMS';
  const safe = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlParagraphs = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.6;font-size:15px;color:#374151">${safe(p)}</p>`).join('');
  return {
    ...withSender({}, kind),
    to,
    subject,
    text: `${title}\n\n${paragraphs.join('\n\n')}\n\nRegards,\n${appName} Support Team`,
    html: mailTemplate.layout({
      title,
      preheader: paragraphs[0] || '',
      bodyHtml: htmlParagraphs + '<p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#374151">Regards,<br><strong>' + safe(appName) + ' Support Team</strong></p>',
      cta: { text: 'Open account security', url: frontendUrl('/settings') },
    }),
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

async function sendPasswordRemovedEmail({ to }) {
  const appName = process.env.APP_NAME || 'ELMS';
  return sendSecurityEmail({
    to,
    subject: appName + ' password removed',
    title: 'You signed in with Google, so the password on your ' + appName + ' account was removed',
    paragraphs: [
      'The password on this account was chosen at sign-up, before the email address was confirmed. Signing in with Google confirmed it, so that password was removed and every other device was signed out.',
      'You can keep signing in with Google. To use an email and password as well, choose "Forgot password?" on the sign-in page and set a new one.',
      'If you did not sign in with Google just now, contact ELMS Support right away.',
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

module.exports = { credentialsFor, frontendUrl, sendWelcomeEmail, sendSignupCodeEmail, sendVoucherEmail, sendPurchaseReceiptEmail, sendInvoiceEmail, sendPlanEndedEmail, sendAffiliateDecisionEmail, sendAffiliatePaidEmail, availableSenders, sendCustomMail, sendTicketReplyEmail, sendAdminAlert, sendAnnouncementEmail, senderAddress, fromHeader, replyToFor, sendSecurityEmail, sendNewDeviceEmail, sendPasswordResetOtp, sendPasswordChangedEmail, sendPasswordRemovedEmail, sendPasswordResetRequestedEmail, sendNewLoginEmail, verifyEmailTransport };
