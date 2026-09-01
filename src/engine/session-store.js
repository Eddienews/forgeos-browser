/*
 * session-store.js — persist & restore open tabs across restarts/crashes.
 *
 * Crash recovery (v0.9.0): when the app exits, the URLs of open http(s) tabs
 * are written to forge-session.json (next to the other runtime artifacts).
 * On next launch, they are restored as tabs. Local-first, never leaves the
 * machine. Ephemeral-mode tabs are never persisted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_RESTORE = 20; // cap tabs restored (session bloat guard)

function sessionFile(runtimeBase) {
  return path.join(runtimeBase, 'forge-session.json');
}

/** Capture open http(s) tab URLs (skip about:blank, ephemeral, and dupes). */
function captureOpenTabs(tabs, runtimeBase) {
  try {
    const urls = [];
    const seen = new Set();
    for (const tab of tabs.values()) {
      const u = tab.url;
      if (!u || !/^https?:/i.test(u)) continue;      // skip blank/internal
      if (tab.forgetOnClose) continue;               // ephemeral → never save
      if (seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
    }
    const file = sessionFile(runtimeBase);
    fs.writeFileSync(file, JSON.stringify({ v: 1, ts: Date.now(), urls }, null, 2), 'utf8');
    return urls.length;
  } catch { return 0; }
}

/** Read previously saved tab URLs (returns [] on none/corrupt). */
function restoreTabs(runtimeBase) {
  try {
    const file = sessionFile(runtimeBase);
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.urls)) return [];
    return data.urls.filter((u) => /^https?:/i.test(u)).slice(0, MAX_RESTORE);
  } catch { return []; }
}

/** Remove the session file (explicit close / "don't restore"). */
function clear(runtimeBase) {
  try { fs.rmSync(sessionFile(runtimeBase), { force: true }); } catch {}
}

module.exports = { captureOpenTabs, restoreTabs, clear, sessionFile };
