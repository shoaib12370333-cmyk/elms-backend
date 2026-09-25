// req.ip must be the visitor. On Render the chain is visitor -> Cloudflare edge -> Render's proxy -> the app; trusting one hop made req.ip a
// Cloudflare address (that is what the live admin panel showed). The test app is a real Express app; the test connects from
// 127.0.0.1 (standing in for Render's proxy) and sends the X-Forwarded-For a real request would carry.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { trustProxySetting, isTrustedHop } = require('../config/trustProxy');
const { clientIp } = require('../services/deviceInfoService');

const build = (setting) => {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/ip', (req, res) => res.json({ ip: req.ip, clean: clientIp(req) }));
  return app;
};
const ask = (server, xff) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/ip', headers: xff ? { 'X-Forwarded-For': xff } : {} }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(JSON.parse(body)));
  });
  req.on('error', reject); req.end();
});
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

(async () => {
  // the addresses seen on the live site are Cloudflare's
  assert.strictEqual(isTrustedHop('172.71.146.121'), true);
  assert.strictEqual(isTrustedHop('104.23.187.40'), true);
  assert.strictEqual(isTrustedHop('::ffff:172.71.146.121'), true, 'an IPv4 address written the IPv6 way');
  assert.strictEqual(isTrustedHop('2606:4700:4700::1111'), true);
  assert.strictEqual(isTrustedHop('10.1.2.3'), true, 'internal');
  assert.strictEqual(isTrustedHop('203.0.113.7'), false, 'an ordinary visitor');
  assert.strictEqual(isTrustedHop('8.8.8.8'), false);
  assert.strictEqual(isTrustedHop('2001:db8::1'), false);
  assert.strictEqual(isTrustedHop('not-an-ip'), false);
  assert.strictEqual(isTrustedHop(''), false);
  assert.strictEqual(isTrustedHop(undefined), false);

  // the setting: our function, unless TRUST_PROXY_HOPS asks for a fixed number of hops
  assert.strictEqual(typeof trustProxySetting({}), 'function');
  assert.strictEqual(trustProxySetting({ TRUST_PROXY_HOPS: '2' }), 2);
  assert.strictEqual(typeof trustProxySetting({ TRUST_PROXY_HOPS: 'abc' }), 'function');
  assert.strictEqual(typeof trustProxySetting({ TRUST_PROXY_HOPS: '0' }), 'function');

  const mine = await listen(build(trustProxySetting({})));
  // visitor, then the Cloudflare edge that Render's proxy saw
  assert.strictEqual((await ask(mine, '203.0.113.7, 172.71.146.121')).ip, '203.0.113.7');
  assert.strictEqual((await ask(mine, '198.51.100.20, 104.23.187.40')).ip, '198.51.100.20');
  // an address the visitor invents themselves sits to the left and is never reached
  assert.strictEqual((await ask(mine, '9.9.9.9, 203.0.113.7, 172.71.146.121')).ip, '203.0.113.7');
  assert.strictEqual((await ask(mine, '1.1.1.1, 2.2.2.2, 203.0.113.7, 104.23.187.40')).ip, '203.0.113.7');
  // IPv6 visitor behind an IPv6 Cloudflare address
  assert.strictEqual((await ask(mine, '2001:db8::1, 2606:4700::1111')).ip, '2001:db8::1');
  // an extra internal hop in the chain is skipped too
  assert.strictEqual((await ask(mine, '203.0.113.7, 172.71.146.121, 10.20.30.40')).ip, '203.0.113.7');
  // no forwarding header: the connection itself
  assert.strictEqual((await ask(mine)).clean, '127.0.0.1');
  // a visitor that did not come through Cloudflare (single address)
  assert.strictEqual((await ask(mine, '203.0.113.7')).ip, '203.0.113.7');
  mine.close();

  // what the old setting did: the Cloudflare address was taken for the visitor
  const old = await listen(build(1));
  assert.strictEqual((await ask(old, '203.0.113.7, 172.71.146.121')).ip, '172.71.146.121');
  old.close();

  console.log('client ip tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
