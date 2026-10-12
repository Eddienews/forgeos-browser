/*
 * https-only.js — upgrade plain-HTTP navigations to HTTPS.
 *
 * A page fetched over HTTP can be read and rewritten by anyone on the network
 * path. With HTTPS-only on, a main-frame navigation to http:// is retried over
 * https://. If the secure attempt fails, the human is asked before the browser
 * falls back; nothing downgrades silently.
 *
 * Hosts that cannot have a public certificate are left alone: loopback,
 * private and link-local addresses, and local-network names.
 */
'use strict';

const net = require('net');
const { isAlwaysBlocked, isPrivate } = require('./url-safety');

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.test', '.invalid', '.example'];

/** True when the host is local by construction and HTTPS cannot be expected. */
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare)) return isPrivate(bare) || isAlwaysBlocked(bare);
  if (host === 'localhost' || !host.includes('.')) return true; // single-label intranet names
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The https:// URL a main-frame http:// navigation should be retried as, or
 * null when it must be left alone.
 *
 * @param {string} url
 * @param {{enabled?: boolean, allowedHosts?: {has: Function}, treatAsPublic?: (host: string) => boolean}} [options]
 *   allowedHosts — hosts the human allowed over HTTP for this session.
 */
function httpsUpgradeTarget(url, { enabled = true, allowedHosts = null, treatAsPublic = null } = {}) {
  if (!enabled) return null;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  if (parsed.protocol !== 'http:' || !parsed.hostname) return null;
  const host = parsed.hostname.toLowerCase();
  if (allowedHosts && allowedHosts.has(host)) return null;
  if (isLocalHost(host) && !(treatAsPublic && treatAsPublic(host))) return null;
  parsed.protocol = 'https:';
  return parsed.href;
}

/**
 * Bookkeeping for one session: which hosts have a secure retry in flight, and
 * which hosts the human allowed over HTTP. Keyed by host, not by tab: the
 * network layer does not reliably say which tab a navigation belongs to.
 * Memory only; allowances end with the session.
 */
function createHttpsOnlyState({ now = Date.now, ttlMs = 120000 } = {}) {
  const pending = new Map(); // host -> { host, httpUrl, httpsUrl, at }
  const allowedHosts = new Set();
  const hostOf = (url, protocol) => {
    try {
      const u = new URL(String(url));
      return !protocol || u.protocol === protocol ? u.hostname.toLowerCase() : '';
    } catch { return ''; }
  };
  return {
    allowedHosts,
    noteUpgrade(httpUrl, httpsUrl) {
      const host = hostOf(httpUrl, 'http:');
      if (!host) return;
      if (pending.size > 200) pending.clear(); // bounded; entries also expire
      pending.set(host, { host, httpUrl, httpsUrl, at: now() });
    },
    /** The upgrade that led to this failed https load, consumed, or null. */
    takeFailedUpgrade(failedUrl) {
      const host = hostOf(failedUrl, 'https:');
      const entry = host && pending.get(host);
      if (!entry) return null;
      pending.delete(host);
      return now() - entry.at > ttlMs ? null : entry;
    },
    /** A page from this host loaded securely: there is nothing to fall back from. */
    settle(loadedUrl) {
      const host = hostOf(loadedUrl, 'https:');
      if (host) pending.delete(host);
    },
    allowHttp(host) { if (host) allowedHosts.add(String(host).toLowerCase()); },
    clear() { pending.clear(); allowedHosts.clear(); },
  };
}

module.exports = { httpsUpgradeTarget, isLocalHost, createHttpsOnlyState, LOCAL_SUFFIXES };
