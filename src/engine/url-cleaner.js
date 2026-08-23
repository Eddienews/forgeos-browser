/*
 * url-cleaner.js — Phase 6: Tracking URL cleanup.
 *
 * Pure logic, no Electron dependency. Strips known tracking parameters from
 * http(s) URLs before navigation while preserving functional parameters.
 *
 * The parameter list is maintained separately in src/lists/tracking-params.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let TRACKING_PARAMS = null;

function loadTrackingParams() {
  if (TRACKING_PARAMS) return TRACKING_PARAMS;
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lists', 'tracking-params.json'), 'utf8');
  const data = JSON.parse(raw);
  TRACKING_PARAMS = new Set(data.params.map((p) => p.toLowerCase()));
  return TRACKING_PARAMS;
}

/**
 * Strip tracking parameters from a URL.
 * @param {string} inputUrl
 * @returns {{url: string, removed: string[], changed: boolean}}
 *   - url: cleaned URL (input unchanged when nothing to strip)
 *   - removed: parameter names that were stripped
 *   - changed: whether the URL was modified
 */
function cleanUrl(inputUrl) {
  const params = loadTrackingParams();
  if (typeof inputUrl !== 'string') {
    return { url: String(inputUrl || ''), removed: [], changed: false };
  }
  // Only clean http/https. Never touch file:, about:, devtools:, data:.
  if (!/^https?:\/\//i.test(inputUrl)) {
    return { url: inputUrl, removed: [], changed: false };
  }
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return { url: inputUrl, removed: [], changed: false };
  }
  const removed = [];
  const kept = [];
  for (const [key, value] of url.searchParams) {
    if (params.has(key.toLowerCase())) {
      removed.push(key);
    } else {
      kept.push([key, value]);
    }
  }
  if (removed.length === 0) {
    return { url: inputUrl, removed: [], changed: false };
  }
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  return { url: url.toString(), removed, changed: true };
}

/**
 * Same as cleanUrl but returns the cleaned URL string (or the original when
 * nothing was removed). Convenience for callers that only need final URL.
 */
function cleanUrlString(inputUrl) {
  return cleanUrl(inputUrl).url;
}

module.exports = { cleanUrl, cleanUrlString, loadTrackingParams };