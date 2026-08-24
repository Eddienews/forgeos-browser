/*
 * cookie-policy.js — Phase 4: cookie policy engine.
 *
 * Default behavior (Standard mode):
 *   First-party cookies       ALLOW
 *   Third-party cookies       BLOCK
 *   Known tracking cookies    BLOCK
 *   Session cookies           ALLOW
 *   Persistent cookies        ALLOW only first-party
 *
 * Strict / Ephemeral:
 *   Persistent cookies        BLOCK
 *   Third-party cookies       BLOCK
 *   Site data                 REMOVE on tab/session close (see storage-manager)
 *
 * Pure decision logic. The Electron adapter (src/ext/electron-adapter.js)
 * applies these decisions to Set-Cookie response headers and to the
 * cookie store. Parsing of Set-Cookie headers is deliberately approximate
 * (documented limitation): we read the first attribute list to decide
 * persistence and name — attribute quoting edge cases are out of scope.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let COOKIE_BLOCKLIST = null;
function loadCookieBlocklist() {
  if (COOKIE_BLOCKLIST) return COOKIE_BLOCKLIST;
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lists', 'tracking-cookies.json'), 'utf8'));
  COOKIE_BLOCKLIST = data.names.map((n) => n.toLowerCase());
  return COOKIE_BLOCKLIST;
}

function nameMatchesBlocklist(name) {
  const lower = name.toLowerCase();
  return loadCookieBlocklist().some((pattern) => {
    if (pattern.endsWith('*')) return lower.startsWith(pattern.slice(0, -1));
    return lower === pattern;
  });
}

/**
 * Parse a Set-Cookie header into { name, value, isPersistent, isSecure,
 * httpOnly, sameSite, domain, raw }.
 * NOTE: approximate parser — adequate for lab policy decisions on common
 * cookies. Quoted attribute values / unusual formatting are best-effort.
 */
function parseSetCookie(header) {
  const raw = header;
  const parts = header.split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  let name = eq === -1 ? first.trim() : first.slice(0, eq).trim();
  let value = eq === -1 ? '' : first.slice(eq + 1).trim();
  let isPersistent = false;
  let domain = null;
  let pathAttr = null;
  let secure = false, httpOnly = false, sameSite = null;
  for (const p of parts) {
    const seg = p.trim();
    const lo = seg.toLowerCase();
    if (lo === 'secure') secure = true;
    else if (lo === 'httponly') httpOnly = true;
    else if (lo.startsWith('expires=')) isPersistent = true;
    else if (lo.startsWith('max-age=')) {
      isPersistent = true; // 0/-1 deletes; policy layer treats persistence flag separately
    } else if (lo.startsWith('domain=')) domain = seg.slice(7).trim();
    else if (lo.startsWith('path=')) pathAttr = seg.slice(5).trim();
    else if (lo.startsWith('samesite=')) sameSite = seg.slice(9).trim().toLowerCase();
  }
  return { name, value, isPersistent, isSecure: secure, httpOnly, sameSite, domain, path: pathAttr, raw };
}

/**
 * Decide whether a Set-Cookie header should be allowed to reach the cookie store.
 *
 * @param {object} ctx
 *   - setCookieHeader: raw header string
 *   - requestOrigin: host of the response (who is setting the cookie)
 *   - tabUrl: URL of the page making the request
 *   - modeId: standard | strict | ephemeral
 * @returns {{decision: 'ALLOW'|'BLOCK', reason: string, cookie?: object}}
 */
function decideSetCookie({ setCookieHeader, requestOrigin, tabUrl, modeId }) {
  const mode = require('./privacy-modes').MODES[modeId] || require('./privacy-modes').MODES.standard;
  const cookie = parseSetCookie(setCookieHeader);
  if (!cookie.name) return { decision: 'BLOCK', reason: 'malformed cookie', cookie };

  let originHost = '';
  try { originHost = new URL(requestOrigin).hostname.toLowerCase(); } catch { originHost = String(requestOrigin || '').toLowerCase(); }

  let tabHost = '';
  try { tabHost = new URL(tabUrl).hostname.toLowerCase(); } catch {}

  const firstParty = tabHost === originHost ||
    (tabHost && originHost && (tabHost.endsWith('.' + originHost) || originHost.endsWith('.' + tabHost)));

  const isTracking = nameMatchesBlocklist(cookie.name);
  // Auth domains: cookies like NID/SAPISID are ESSENTIAL to Google/YouTube
  // sign-in flows. Blocking them on their own first-party auth host breaks
  // login ("Couldn't sign you in"). Only treat as tracking when third-party.
  const AUTH_HOSTS = ['accounts.google.com', 'play.google.com', 'accounts.youtube.com'];
  const isAuthOrigin = AUTH_HOSTS.some((h) => originHost === h || originHost.endsWith('.' + h));
  if (isTracking && !(isAuthOrigin && firstParty)) {
    return { decision: 'BLOCK', reason: 'known tracking cookie', cookie };
  }

  if (!firstParty) {
    return { decision: 'BLOCK', reason: 'third-party cookie', cookie };
  }

  if (mode.blockPersistentCookies && cookie.isPersistent) {
    return { decision: 'BLOCK', reason: 'persistent cookie blocked by mode', cookie };
  }

  if (mode.blockThirdPartyCookies) {
    // already handled above for real third parties
  }

  return { decision: 'ALLOW', reason: 'first-party cookie', cookie };
}

/**
 * Strip disallowed Set-Cookie headers from a responseHeaders object.
 * Electron adapter helper.
 */
function filterSetCookieHeaders(responseHeaders, { requestUrl, tabUrl, modeId }) {
  const out = {};
  let blocked = [];
  for (const [k, v] of Object.entries(responseHeaders)) {
    if (k.toLowerCase() === 'set-cookie') {
      const allowed = [];
      for (const header of v) {
        const res = decideSetCookie({ setCookieHeader: header, requestOrigin: requestUrl, tabUrl, modeId });
        if (res.decision === 'ALLOW') allowed.push(header);
        else blocked.push({ name: res.cookie ? res.cookie.name : '?', reason: res.reason });
      }
      if (allowed.length) out[k] = allowed;
    } else {
      out[k] = v;
    }
  }
  return { headers: out, blocked };
}

/**
 * Decide whether an existing cookie in the jar is acceptable (used after
 * load, e.g. before exposing counts on the dashboard). Keeps the same
 * policy logic.
 */
function decideExistingCookie(cookie, { modeId, tabHost }) {
  const mode = require('./privacy-modes').MODES[modeId] || require('./privacy-modes').MODES.standard;
  if (nameMatchesBlocklist(cookie.name)) return { decision: 'BLOCK', reason: 'known tracking cookie' };
  const domain = (cookie.domain || '').toLowerCase();
  const firstParty = !tabHost || domain === tabHost || domain.endsWith('.' + tabHost) || tabHost.endsWith('.' + domain);
  if (!firstParty) return { decision: 'BLOCK', reason: 'third-party cookie' };
  if (mode.blockPersistentCookies && cookie.session === false) return { decision: 'BLOCK', reason: 'persistent cookie blocked by mode' };
  return { decision: 'ALLOW', reason: 'allowed first-party cookie' };
}

module.exports = {
  parseSetCookie,
  decideSetCookie,
  filterSetCookieHeaders,
  decideExistingCookie,
  nameMatchesBlocklist,
};