/*
 * desktop-integration.js — pure decisions for behaving like a desktop browser:
 * which keyboard shortcut was pressed, and which command-line arguments are
 * links another application asked this browser to open.
 *
 * Both inputs are untrusted in the sense that matters: a key event arrives
 * while a web page has focus, and command-line arguments come from whatever
 * program launched the browser.
 */
'use strict';

const MAX_EXTERNAL_URLS = 10;

/**
 * Map one Electron `before-input-event` input to a browser action name, or
 * null. Only chords a page has no legitimate claim on are taken: every one
 * needs Ctrl/Cmd, Alt, or a function key, so ordinary typing is never touched.
 */
function shortcutAction(input) {
  if (!input || input.type !== 'keyDown' || typeof input.key !== 'string' || !input.key) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const primary = !!(input.control || input.meta);
  const { alt, shift } = input;

  if (!primary && !alt) {
    if (key === 'F5' && !shift) return 'reload';
    if (key === 'F6' && !shift) return 'focus-address';
    if (key === 'F11' && !shift) return 'fullscreen';
    if (key === 'F12' && !shift) return 'devtools';
    return null;
  }
  if (alt && !primary && !shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    if (key === 'd') return 'focus-address';
    return null;
  }
  if (!primary || alt) return null;

  // Ctrl+Tab cycles; holding the key down must not spin through every tab.
  if (key === 'Tab') return input.isAutoRepeat ? null : (shift ? 'previous-tab' : 'next-tab');
  if (key === 'PageDown' && !shift) return 'next-tab';
  if (key === 'PageUp' && !shift) return 'previous-tab';
  if (input.isAutoRepeat) return key === '=' || key === '+' || key === '-' ? zoomAction(key) : null;
  if (shift) return key === 'i' ? 'devtools' : key === '+' ? 'zoom-in' : key === 't' ? 'reopen-tab' : null;
  switch (key) {
    case 't': return 'new-tab';
    case 'w': return 'close-tab';
    case 'l': return 'focus-address';
    case 'r': return 'reload';
    case 'p': return 'print';
    case 'q': return 'quit';
    case '=': case '+': case '-': return zoomAction(key);
    case '0': return 'zoom-reset';
    case '9': return 'last-tab';
    default: return /^[1-8]$/.test(key) ? `tab-${key}` : null;
  }
}

function zoomAction(key) { return key === '-' ? 'zoom-out' : 'zoom-in'; }

/** Next zoom percentage for a zoom action, clamped to the supported range. */
function nextZoom(current, action) {
  const now = Math.max(50, Math.min(200, Math.round(Number(current) || 100)));
  if (action === 'zoom-reset') return 100;
  if (action === 'zoom-in') return Math.min(200, now + 10);
  if (action === 'zoom-out') return Math.max(50, now - 10);
  return now;
}

/** Which tab a tab-switching action selects, given the ordered ids. */
function tabTarget(action, orderedIds, activeId) {
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  if (!ids.length) return null;
  const at = ids.indexOf(activeId);
  if (action === 'next-tab') return ids[(at + 1 + ids.length) % ids.length];
  if (action === 'previous-tab') return ids[(at - 1 + ids.length) % ids.length];
  if (action === 'last-tab') return ids[ids.length - 1];
  const numbered = /^tab-([1-8])$/.exec(String(action));
  if (numbered) return ids[Number(numbered[1]) - 1] ?? null;
  return null;
}

const MAX_CLOSED_TABS = 10;

/**
 * What to remember about a tab the user just closed, so Ctrl+Shift+T can bring
 * it back, or null when it must be forgotten. Remembering a tab is a small
 * history record, so it follows the same rule as history: nothing from an
 * agent tab, a forget-on-close tab, or a mode that keeps no history, and only
 * a real http(s) page. The list lives in memory and is never written to disk.
 */
function closedTabRecord(tab) {
  if (!tab || tab.agentOwned || tab.forgetOnClose || tab.retainHistory === false || tab.restoreOnRestart === false) return null;
  const url = typeof tab.url === 'string' ? tab.url : '';
  if (url.length > 4096) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return { url: parsed.href, containerId: tab.containerId == null ? null : String(tab.containerId) };
}

/** Push onto the most-recent-first list, keeping at most `limit` entries. */
function rememberClosedTab(list, record, limit = MAX_CLOSED_TABS) {
  if (!Array.isArray(list) || !record) return list;
  list.unshift(record);
  if (list.length > limit) list.length = limit;
  return list;
}

/**
 * Links passed on the command line (a desktop "open with", or a second launch
 * while the browser is running). Only complete http(s) URLs are accepted:
 * never a switch, a path, a file: URL, or anything carrying credentials.
 */
function externalUrls(argv) {
  const urls = [];
  for (const arg of Array.isArray(argv) ? argv.slice(1) : []) {
    if (typeof arg !== 'string' || arg.length > 4096 || arg.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(arg)) continue;
    if (!/^https?:\/\//i.test(arg)) continue;
    let parsed;
    try { parsed = new URL(arg); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    if (!urls.includes(parsed.href)) urls.push(parsed.href);
    if (urls.length >= MAX_EXTERNAL_URLS) break;
  }
  return urls;
}

module.exports = {
  shortcutAction, nextZoom, tabTarget, externalUrls, closedTabRecord, rememberClosedTab,
  MAX_EXTERNAL_URLS, MAX_CLOSED_TABS,
};
