// Sign-up refuses example / test addresses, temporary-mail services, typos of the big providers and domains that take no mail;
// a slow or failing DNS never stops a real person. The DNS is a fake zone, nothing goes to the network.
const assert = require('assert');
const { checkEmailQuality, setResolver } = require('../services/emailQualityService');

const ZONE = {
  'gmail.com': { mx: [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] },
  'company.io': { mx: [{ exchange: 'mx1.company.io', priority: 10 }] },
  'nomx-has-a.com': { mx: 'ENODATA', a: ['203.0.113.9'] },
  'nomx-none.com': { mx: 'ENODATA', a: 'ENODATA', aaaa: 'ENODATA' },
  'gone.com': { mx: 'ENOTFOUND' },
  'nullmx.com': { mx: [{ exchange: '', priority: 0 }] },
  'slow.com': { mx: 'HANG' },
  'flaky.com': { mx: 'ESERVFAIL' },
};
const lookups = [];
const answer = (value) => {
  if (value === 'HANG') return new Promise(() => {});
  if (typeof value === 'string') return Promise.reject(Object.assign(new Error(value), { code: value }));
  return Promise.resolve(value || []);
};
const fakeDns = {
  resolveMx: (d) => { lookups.push(d); return answer(ZONE[d] ? ZONE[d].mx : 'ENOTFOUND'); },
  resolve4: (d) => answer(ZONE[d] && ZONE[d].a !== undefined ? ZONE[d].a : 'ENODATA'),
  resolve6: (d) => answer(ZONE[d] && ZONE[d].aaaa !== undefined ? ZONE[d].aaaa : 'ENODATA'),
};

(async () => {
  setResolver(fakeDns);
  const check = (email) => checkEmailQuality(email, { timeoutMs: 60 });
  const refused = async (email, reason) => { const r = await check(email); assert.strictEqual(r.ok, false, email + ' should be refused'); assert.strictEqual(r.reason, reason, email + ' -> ' + r.reason); assert.ok(r.message.length > 10); return r; };

  // real addresses pass
  assert.deepStrictEqual(await check('someone@gmail.com'), { ok: true });
  assert.deepStrictEqual(await check('Owner@Company.io'), { ok: true }, 'upper case is fine');
  assert.deepStrictEqual(await check('  padded@gmail.com  '), { ok: true });

  // not an address at all
  await refused('nobody', 'format');
  await refused('@gmail.com', 'format');
  await refused('name@', 'format');
  await refused('', 'format');

  // documentation / test names (the address that was found on the live site)
  await refused('scan1790349045@example.com', 'reserved');
  await refused('a@EXAMPLE.org', 'reserved');
  await refused('a@mail.example.net', 'reserved');
  await refused('a@foo.test', 'reserved');
  await refused('a@foo.invalid', 'reserved');
  await refused('a@server.local', 'reserved');
  await refused('a@localhost', 'reserved');

  // temporary-mail services, also as a subdomain, whatever the case
  await refused('scan1790352722q@mailinator.com', 'disposable');
  await refused('x@Yopmail.COM', 'disposable');
  await refused('x@inbox.guerrillamail.com', 'disposable');
  await refused('x@10minutemail.com', 'disposable');
  process.env.BLOCKED_EMAIL_DOMAINS = 'my-junk.org, another-junk.net';
  await refused('x@my-junk.org', 'disposable');
  await refused('x@sub.another-junk.net', 'disposable');
  delete process.env.BLOCKED_EMAIL_DOMAINS;
  assert.deepStrictEqual(await check('x@company.io'), { ok: true }, 'a name that only ends the same way is not blocked');

  // typos of the big providers say what was probably meant
  let r = await refused('rao@gmial.com', 'typo');
  assert.strictEqual(r.suggestion, 'gmail.com');
  assert.ok(r.message.includes('rao@gmail.com'), r.message);
  await refused('rao@hotmial.com', 'typo');
  await refused('rao@gmail.con', 'typo');

  // DNS: no such domain, a domain that says it takes no mail
  await refused('a@gone.com', 'no_mail');
  await refused('a@nullmx.com', 'no_mail');
  await refused('a@nomx-none.com', 'no_mail');
  // no MX record but the domain itself takes mail (A record): allowed, as mail servers do
  assert.deepStrictEqual(await check('a@nomx-has-a.com'), { ok: true });

  // DNS trouble never stops a real person
  assert.deepStrictEqual(await check('a@slow.com'), { ok: true }, 'a lookup that hangs is allowed');
  assert.deepStrictEqual(await check('a@flaky.com'), { ok: true }, 'a failing lookup is allowed');
  setResolver({ resolveMx: () => { throw new Error('resolver crashed'); }, resolve4: () => [], resolve6: () => [] });
  assert.deepStrictEqual(await check('a@anything.com'), { ok: true }, 'even a crashing resolver is allowed');

  // answers are remembered: the same domain is not asked twice
  setResolver(fakeDns);
  lookups.length = 0;
  await check('one@gmail.com'); await check('two@gmail.com'); await check('three@gmail.com');
  assert.strictEqual(lookups.filter((d) => d === 'gmail.com').length, 1);
  // ... but a failed lookup is not remembered as an answer
  lookups.length = 0;
  await check('a@flaky.com'); await check('b@flaky.com');
  assert.strictEqual(lookups.length, 2);

  console.log('email quality tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
