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

/** True for addresses that must never be reached by an agent-initiated nav. */
function isAlwaysBlocked(ip) {
  // Link-local (169.254.0.0/16, fe80::/10) — includes cloud metadata endpoints.
  if (ip.startsWith('169.254.')) return true;
  if (/^fe80:/i.test(ip)) return true;
  if (ip === '::1' || ip === '0.0.0.0' || ip === '::') return true;
  // Multicast / reserved ranges we treat as off-limits for agents.
  if (/^22[4-9]\./.test(ip) || /^23[0-9]\./.test(ip) || /^24[0-9]\./.test(ip) || /^25[0-5]\./.test(ip)) return true;
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true; // IPv6 multicast
  return false;
}

/** True for loopback + RFC1918 + IPv6 unique-local (private) addresses. */
function isPrivate(ip) {
  if (ip === '127.0.0.1' || /^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true; // IPv6 ULA
  if (/^::$/.test(ip)) return true;
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
  const literal = net.isIP(host) ? host : null;
  const addresses = literal
    ? [literal]
    : await (async () => {
      try {
        const records = await lookup(host);
        return (Array.isArray(records) ? records : [records])
          .map((r) => (typeof r === 'string' ? r : r && r.address))
          .filter(Boolean);
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
    if (net.isIP(h)) return isAlwaysBlocked(h) || isPrivate(h);
    if (/^localhost$/i.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

module.exports = { ensureNavigable, isObviouslyBlocked, isAlwaysBlocked, isPrivate, UnsafeUrlError };
