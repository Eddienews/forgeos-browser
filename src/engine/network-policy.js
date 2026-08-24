/*
 * network-policy.js — Phase 2/3 policy layer.
 *
 * Turns a request classification into a decision:
 *
 *   FIRST_PARTY   → ALLOW
 *   FUNCTIONAL    → ALLOW
 *   ADVERTISING   → BLOCK
 *   TRACKING      → BLOCK
 *   ANALYTICS     → BLOCK (by default)
 *   THIRD_PARTY   → evaluate (allow in Standard if no filter matched;
 *                   restrict non-document third-party subresources in
 *                   Strict/Ephemeral)
 *   UNKNOWN       → ALLOW unless strict mode
 *
 * Pure logic, unit-testable.
 */
'use strict';

const { MODES } = require('./privacy-modes');

const NON_DOCUMENT_TYPES = new Set(['image', 'script', 'stylesheet', 'font', 'media',
  'xmlhttprequest', 'ping', 'csp_report', 'other', 'object', 'webSocket']);
const DOCUMENT_TYPES = new Set(['mainFrame', 'subFrame', 'document']);

/**
 * @param {object} classification from FilterEngine.classifyRequest
 * @param {string} modeId standard | strict | ephemeral
 * @returns {{decision: 'ALLOW'|'BLOCK'|'EVALUATE', reason: string}}
 */
function applyPolicy(classification, modeId) {
  const mode = MODES[modeId] || MODES.standard;
  const cat = classification.category;
  const type = classification.resourceType || 'other';
  const firstParty = classification.firstParty === true;

  // Explicit filter-list verdicts are authoritative (before category policy).
  if (classification.filterDecision === 'block') {
    // SAFETY: broad substring/regex rules from full lists must NEVER block
    // top-level navigation — a false positive there makes whole sites fail
    // to load (observed: EasyList '/e/cm?' blocked youtube.com mainFrame).
    if (type === 'mainFrame' &&
        classification.matchedKind && classification.matchedKind !== 'hostname') {
      return { decision: 'ALLOW', reason: 'filter match is too broad for mainFrame navigation' };
    }
    // AUTH ENDPOINTS: EasyList blocks play.google.com/log (used DURING Google
    // sign-in). Blocking it breaks YouTube login ("Couldn't sign you in").
    // Requests to auth hosts from a Google/YouTube tab always pass.
    try {
      const tabHost = new URL(classification.tabUrl).hostname.toLowerCase();
      const originHost = new URL(classification.url).hostname.toLowerCase();
      const AUTH_HOSTS = ['accounts.google.com', 'play.google.com', 'accounts.youtube.com'];
      const isAuthOrigin = AUTH_HOSTS.some((h) => originHost === h || originHost.endsWith('.' + h));
      const isGoogleEcoTab = ['youtube.com', 'google.com', 'youtubekids.com', 'googlevideo.com']
        .some((h) => tabHost === h || tabHost.endsWith('.' + h));
      if (isAuthOrigin && (isGoogleEcoTab || !tabHost)) {
        return { decision: 'ALLOW', reason: 'auth endpoint first-party exemption' };
      }
    } catch {}
    return { decision: 'BLOCK', reason: `filter list: ${classification.matchedRule || 'blocked'}` };
  }
  if (classification.filterDecision === 'exception') {
    return { decision: 'ALLOW', reason: `filter list exception: ${classification.matchedRule || 'allowed'}` };
  }

  switch (cat) {
    case 'FIRST_PARTY':
    case 'FUNCTIONAL':
      return { decision: 'ALLOW', reason: `${cat.toLowerCase()} resource` };
    case 'ADVERTISING':
      return { decision: 'BLOCK', reason: 'advertising' };
    case 'TRACKING':
      return { decision: 'BLOCK', reason: 'tracking' };
    case 'ANALYTICS':
      return { decision: 'BLOCK', reason: 'analytics' };
    case 'THIRD_PARTY': {
      if (!firstParty && mode.restrictThirdPartyResources && !DOCUMENT_TYPES.has(type)) {
        return { decision: 'BLOCK', reason: 'third-party subresource restricted in strict mode' };
      }
      return { decision: 'ALLOW', reason: 'third-party, no filter match' };
    }
    case 'UNKNOWN':
    default:
      if (mode.restrictThirdPartyResources && !firstParty && !DOCUMENT_TYPES.has(type)) {
        return { decision: 'BLOCK', reason: 'unknown third-party request, blocked in strict mode' };
      }
      return { decision: 'ALLOW', reason: 'unknown, allowed by default' };
  }
}

/**
 * Convenience: full decision pipeline for one request.
 */
function decideRequest({ url, tabUrl, resourceType, engine, modeId }) {
  const cls = engine.classifyRequest({ url, tabUrl, resourceType });
  const policy = applyPolicy({ ...cls, resourceType, url, tabUrl }, modeId);
  return { ...cls, resourceType, ...policy };
}

module.exports = { applyPolicy, decideRequest, NON_DOCUMENT_TYPES, DOCUMENT_TYPES };