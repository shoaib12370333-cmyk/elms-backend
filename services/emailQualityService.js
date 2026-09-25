const dns = require('dns').promises;

/**
 * Is this a real address someone could own? Used at sign-up, before anything is created. It cannot know that the mailbox exists
 * (only the confirmation code proves that), but it stops the obvious junk: example / test addresses, temporary-mail services,
 * typos of the big providers, and domains that do not exist or do not take mail.
 */

// Names reserved for documentation and tests (RFC 2606 / 6761): nobody can own a mailbox there.
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu'];
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost', 'local', 'internal', 'lan', 'onion'];

// Temporary / throw-away mailbox services (a subdomain of one of these counts too). More can be added with BLOCKED_EMAIL_DOMAINS.
const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'notmailinator.com', 'mailinater.com', 'binkmail.com', 'bobmail.info', 'chammy.info',
  'devnullmail.com', 'letthemeatspam.com', 'reallymymail.com', 'safetymail.info', 'sogetthis.com', 'spamhereplease.com', 'superrito.com',
  'thisisnotmyrealemail.com', 'tradermail.info', 'veryrealemail.com', 'zippymail.info',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '10minutemail.co.uk', '20minutemail.com', 'minutemail.com',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempmailo.com', 'tempail.com', 'tempinbox.com', 'tempm.com', 'tempmailer.com',
  'tmpmail.org', 'tmpmail.net', 'throwawaymail.com', 'gettempmail.com', 'mytemp.email', 'tempr.email', 'emltmp.com',
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trash-mail.com', 'trashmail.io',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.org', 'nospam.ze.tc', 'nomail.xl.cc',
  'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mintemail.com', 'mohmal.com', 'moakt.com',
  'fakeinbox.com', 'fakemail.net', 'emailondeck.com', 'spamgourmet.com', 'burnermail.io', 'discard.email', 'discardmail.com', 'spambox.us',
  '1secmail.com', '1secmail.net', '1secmail.org', 'esiix.com', 'wwjmp.com', 'xojxe.com', 'yoggm.com', 'vjuum.com', 'laafd.com', 'txcct.com',
  'dropmail.me', 'mailforspam.com', 'inboxkitten.com', 'harakirimail.com', 'mailsac.com', 'spamex.com', 'anonbox.net', 'e4ward.com', 'incognitomail.org',
];

// Misspelled copies of the big providers: the person would never get the code, and the address may belong to a stranger.
const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmil.com': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outllook.com': 'outlook.com', 'outlook.con': 'outlook.com',
};

const MESSAGES = {
  format: 'Please enter a valid email address.',
  reserved: 'Please enter your real email address. Example and test addresses cannot be used.',
  disposable: 'Temporary email addresses cannot be used. Please use your own email address.',
  noMail: 'That email domain cannot receive email. Please check the spelling of your address.',
};

const DNS_TIMEOUT_MS = 2500;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // domain -> { at, ok }

let resolver = dns;
/** Tests give their own DNS. */
function setResolver(custom) { resolver = custom || dns; cache.clear(); }

const domainOf = (email) => String(email || '').trim().toLowerCase().split('@').pop().replace(/\.$/, '');
const matches = (domain, name) => domain === name || domain.endsWith('.' + name);

function blockedByList(domain) {
  const extra = String(process.env.BLOCKED_EMAIL_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return DISPOSABLE_DOMAINS.concat(extra).some((name) => matches(domain, name));
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS timed out'), { code: 'ETIMEOUT' })), ms))]);

/**
 * Can the domain take mail? true / false, or null when DNS could not say (a slow or failing lookup must never stop a real person).
 * A domain with no MX record still takes mail at its own address (A / AAAA), as mail servers do.
 */
async function domainTakesMail(domain, timeoutMs) {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let ok = null;
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeoutMs);
    // "MX 0 ." (null MX) is a domain saying it takes no mail at all
    ok = mx.some((r) => r && r.exchange && r.exchange !== '.');
  } catch (err) {
    if (err && err.code === 'ENODATA') {
      try {
        const [a, aaaa] = await Promise.all([
          withTimeout(resolver.resolve4(domain), timeoutMs).catch((e) => (e && (e.code === 'ENODATA' || e.code === 'ENOTFOUND') ? [] : Promise.reject(e))),
          withTimeout(resolver.resolve6(domain), timeoutMs).catch((e) => (e && (e.code === 'ENODATA' || e.code === 'ENOTFOUND') ? [] : Promise.reject(e))),
        ]);
        ok = a.length + aaaa.length > 0;
      } catch (_) { ok = null; }
    } else if (err && (err.code === 'ENOTFOUND' || err.code === 'NXDOMAIN')) {
      ok = false;
    }
  }
  if (ok !== null) {
    cache.set(domain, { at: Date.now(), ok });
    if (cache.size > 5000) cache.clear();
  }
  return ok;
}

/**
 * @returns {Promise<{ok: true} | {ok: false, reason: string, message: string}>} never throws
 */
async function checkEmailQuality(email, { timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const clean = String(email || '').trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1 || at === clean.length - 1) return { ok: false, reason: 'format', message: MESSAGES.format };
  const domain = domainOf(clean);
  const tld = domain.split('.').pop();

  if (RESERVED_DOMAINS.some((name) => matches(domain, name)) || RESERVED_TLDS.includes(tld) || !domain.includes('.')) {
    return { ok: false, reason: 'reserved', message: MESSAGES.reserved };
  }
  if (blockedByList(domain)) return { ok: false, reason: 'disposable', message: MESSAGES.disposable };
  if (TYPO_DOMAINS[domain]) {
    return { ok: false, reason: 'typo', suggestion: TYPO_DOMAINS[domain], message: 'Did you mean ' + clean.slice(0, at) + '@' + TYPO_DOMAINS[domain] + '? Please check the spelling of your email address.' };
  }
  const takesMail = await domainTakesMail(domain, timeoutMs).catch(() => null);
  if (takesMail === false) return { ok: false, reason: 'no_mail', message: MESSAGES.noMail };
  return { ok: true };
}

module.exports = { checkEmailQuality, setResolver };
