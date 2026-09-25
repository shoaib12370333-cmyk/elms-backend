const net = require('net');

/**
 * Which addresses in the request's proxy chain are OUR proxies, so that req.ip is the visitor and not a proxy.
 *
 * On Render the chain is: visitor -> Cloudflare edge -> Render's proxy -> this app. A plain "trust 1 hop" made req.ip the
 * Cloudflare edge address, shared by thousands of people: the IP limits, IP blocks, the new-account-per-network guard and the
 * sign-in location all looked at the wrong address.
 *
 * The hop that connects to the app (0) is Render's own proxy and is always trusted (so this is never worse than before). After it,
 * Cloudflare's published ranges and internal addresses are skipped; the first address that is none of these is the visitor.
 * An address a visitor writes into X-Forwarded-For themselves sits further left, so it is never reached.
 *
 * Cloudflare's list: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6 (rarely changes; keep it current).
 * TRUST_PROXY_HOPS=<n> in the environment goes back to trusting a fixed number of hops.
 */
const RANGES = [
  // Cloudflare IPv4
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  // Cloudflare IPv6
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
  // internal addresses (loopback, private, link-local, carrier-grade NAT)
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10',
];

const trusted = new net.BlockList();
for (const range of RANGES) {
  const [address, prefix] = range.split('/');
  trusted.addSubnet(address, Number(prefix), net.isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** True for a Cloudflare edge address or an internal address. */
function isTrustedHop(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  const family = net.isIP(ip);
  return family !== 0 && trusted.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** The function Express asks for every address of the chain: (address, hop) where hop 0 is whoever connected to the app. */
function trustProxy(address, hop) {
  return hop === 0 || isTrustedHop(address);
}

/** What server.js gives to app.set('trust proxy', ...). */
function trustProxySetting(env = process.env) {
  const hops = Number(env.TRUST_PROXY_HOPS);
  return Number.isInteger(hops) && hops > 0 ? hops : trustProxy;
}

module.exports = { trustProxy, trustProxySetting, isTrustedHop };
