// Guards for server-side requests to user-supplied URLs: only public addresses are allowed, and the connection is pinned
// to the address that was checked.
const dns = require('dns');
const net = require('net');

function normalizeIpAddress(address) {
  if (!address) return '';
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : address;
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

function inCidrV4(ip, cidrBase, prefix) {
  const ipNum = ipToLong(ip);
  const baseNum = ipToLong(cidrBase);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipNum & mask) === (baseNum & mask);
}

function isPrivateOrLocalAddress(address) {
  const normalized = normalizeIpAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true;
  if (family === 4) {
    return (
      inCidrV4(normalized, '0.0.0.0', 8) ||
      inCidrV4(normalized, '10.0.0.0', 8) ||
      inCidrV4(normalized, '100.64.0.0', 10) ||
      inCidrV4(normalized, '127.0.0.0', 8) ||
      inCidrV4(normalized, '169.254.0.0', 16) ||
      inCidrV4(normalized, '172.16.0.0', 12) ||
      inCidrV4(normalized, '192.0.0.0', 24) ||
      inCidrV4(normalized, '192.0.2.0', 24) ||
      inCidrV4(normalized, '192.168.0.0', 16) ||
      inCidrV4(normalized, '198.18.0.0', 15) ||
      inCidrV4(normalized, '198.51.100.0', 24) ||
      inCidrV4(normalized, '203.0.113.0', 24) ||
      inCidrV4(normalized, '224.0.0.0', 4) ||
      inCidrV4(normalized, '240.0.0.0', 4)
    );
  }
  const value = normalized.toLowerCase();
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    value.startsWith('fec0:') ||
    value.startsWith('ff')
  );
}

async function resolvePublicIp(hostname) {
  const lookups = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!lookups.length) throw new Error('Host resolution failed');
  const sortedLookups = [
    ...lookups.filter(result => result.family === 4),
    ...lookups.filter(result => result.family !== 4)
  ];
  for (const result of sortedLookups) {
    if (!isPrivateOrLocalAddress(result.address)) return result;
  }
  throw new Error('Private network targets are blocked');
}

async function publicRequestOptions(targetUrl, baseOptions = {}) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
  const resolved = await resolvePublicIp(parsed.hostname);
  return {
    ...baseOptions,
    lookup: (_hostname, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      const lookupOptions = typeof options === 'function' ? {} : (options || {});
      if (lookupOptions.all) {
        done(null, [{ address: resolved.address, family: resolved.family }]);
        return;
      }
      done(null, resolved.address, resolved.family);
    }
  };
}

module.exports = { isPrivateOrLocalAddress, resolvePublicIp, publicRequestOptions };
