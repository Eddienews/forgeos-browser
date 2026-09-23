/*
 * url-safety.js — navigation safety for agent-supplied URLs (SSRF defense).
 *
 * Why this exists: the Agent API accepts a `url` argument that is chosen by a
 * model, not typed by a person. A prompt-injected page can talk an agent into
 * re-invoking /navigate against an internal service, a home router, or a cloud
 * metadata endpoint (169.254.169.254) — and then read the response back through
 * GET /page. This module is the single checkpoint every AGENT navigation passes
 * through before it runs.
 *
 * Design notes:
 *  - The restriction applies to the AGENT. A human typing a URL in the address
 *    bar is not routed through here (their choice, their machine).
 *  - All resolved addresses are checked, not just the first: a hostname that
 *    resolves to both a public and a private address is rejected.
 *  - Link-local is always blocked, even when private networks are allowed,
 *    because 169.254.169.254 is the cloud metadata endpoint.
 *
 * Pattern adapted (MIT) from ndrezn/ts-browser-agent
 * (src/ts_browser_agent/safety.py) and browser-use/jev-ultrafast.
 */
'use strict';

const dns = require('dns');
const net = require('net');

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Parse IPs before classifying them; IPv4-mapped IPv6 shares IPv4 rules. */
function parseAddress(value) {
  if (typeof value !== 'string') return null;
  const ip = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const family = net.isIP(ip);
  if (family === 4) return { family, ip };
  if (family !== 6) return null;

  // WHATWG URL canonicalizes valid IPv6, including dotted IPv4 tails.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const halves = canonical.split('::');
  const left = halves[0] ? halves[0].split(':').map((part) => parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map((part) => parseInt(part, 16)) : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  // ::ffff:0:0/96 is IPv4-mapped, whether written in dotted or hex form.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { family: 4, ip: `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}` };
  }
  return { family: 6, groups };
}

/** True for addresses that must never be reached by an agent-initiated nav. */
function isAlwaysBlocked(ip) {
  const address = parseAddress(ip);
  if (!address) return true; // Unknown address is never safe to pass through.
  if (address.family === 6) {
    const g = address.groups;
    return (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      g.every((part) => part === 0) || // unspecified
      (g[0] === 0 && g.slice(1, 7).every((part) => part === 0) && g[7] === 1) ||
      (g[0] & 0xff00) === 0xff00; // multicast
  }
  ip = address.ip;
  // Link-local (169.254.0.0/16, fe80::/10) — includes cloud metadata endpoints.
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  // Multicast / reserved ranges we treat as off-limits for agents.
  if (/^22[4-9]\./.test(ip) || /^23[0-9]\./.test(ip) || /^24[0-9]\./.test(ip) || /^25[0-5]\./.test(ip)) return true;
  return false;
}

/** True for loopback + RFC1918 + IPv6 unique-local (private) addresses. */
function isPrivate(ip) {
  const address = parseAddress(ip);
  if (!address) return true;
  if (address.family === 6) return (address.groups[0] & 0xfe00) === 0xfc00; // fc00::/7 ULA
  ip = address.ip;
  if (ip === '127.0.0.1' || /^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  return false;
}

/**
 * Validate a URL an agent wants to navigate to.
 *
 * @param {string} url
 * @param {{allowPrivate?: boolean, resolver?: Function}} [opts]
 *   allowPrivate — permit loopback/private (local dev server). Link-local and
 *   cloud-metadata ranges stay blocked regardless.
 *   resolver — injectable DNS lookup (tests).
 * @returns {Promise<string>} the URL, unchanged, once it passes
 * @throws {UnsafeUrlError}
 */
async function ensureNavigable(url, opts = {}) {
  const allowPrivate = opts.allowPrivate === true;
  const lookup = opts.resolver || ((host) => dns.promises.lookup(host, { all: true }));

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new UnsafeUrlError('URL is not parseable.');
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UnsafeUrlError(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (!host) throw new UnsafeUrlError('URL has no hostname.');

  // Literal IPs are checked directly (no DNS needed).
  const literal = net.isIP(host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host) ? host : null;
  const addresses = literal
    ? [literal]
    : await (async () => {
      try {
        const records = await lookup(host);
        return (Array.isArray(records) ? records : [records])
          .map((r) => (typeof r === 'string' ? r : r && r.address));
      } catch {
        throw new UnsafeUrlError(`Could not resolve hostname '${host}'.`);
      }
    })();

  if (!addresses.length) throw new UnsafeUrlError(`Hostname '${host}' resolved to no address.`);

  for (const addr of addresses) {
    if (isAlwaysBlocked(addr)) {
      throw new UnsafeUrlError(
        `'${host}' resolves to an address agents must never reach: ${addr}`,
      );
    }
    if (!allowPrivate && isPrivate(addr)) {
      throw new UnsafeUrlError(
        `'${host}' resolves to a private address (${addr}). Pass allowPrivate to permit a local dev server.`,
      );
    }
  }
  return url;
}

/** Synchronous variant for already-resolved checks (UX hints, not enforcement). */
function isObviouslyBlocked(url) {
  try {
    const u = new URL(String(url));
    if (!ALLOWED_SCHEMES.has(u.protocol)) return true;
    const h = u.hostname;
    if (net.isIP(h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h)) {
      return isAlwaysBlocked(h) || isPrivate(h);
    }
    if (/^localhost$/i.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

module.exports = { ensureNavigable, isObviouslyBlocked, isAlwaysBlocked, isPrivate, UnsafeUrlError };
