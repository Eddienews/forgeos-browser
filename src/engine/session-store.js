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
const { CONTAINER_IDS } = require('./storage-manager');

const MAX_RESTORE = 20; // cap tabs restored (session bloat guard)

function sessionFile(runtimeBase) {
  return path.join(runtimeBase, 'forge-session.json');
}

/** Capture open http(s) tab URLs (skip about:blank, ephemeral, and dupes). */
function captureOpenTabs(tabs, runtimeBase) {
  let tmpFile = null;
  try {
    const records = [];
    const seen = new Set();
    for (const tab of tabs.values()) {
      const u = tab.url;
      if (!u || !/^https?:/i.test(u)) continue;      // skip blank/internal
      if (tab.agentOwned || tab.forgetOnClose || tab.restoreOnRestart === false) continue;
      const containerId = tab.containerId == null ? null : tab.containerId;
      if (containerId != null && !CONTAINER_IDS.includes(containerId)) continue;
      const key = JSON.stringify([u, containerId]);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ url: u, containerId });
    }
    const file = sessionFile(runtimeBase);
    tmpFile = file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify({ v: 2, ts: Date.now(), tabs: records }, null, 2), 'utf8');
    fs.renameSync(tmpFile, file);
    return records.length;
  } catch {
    if (tmpFile) {
      try { fs.rmSync(tmpFile, { force: true }); } catch {}
    }
    return 0;
  }
}

/** Reopen only validated human URLs in their original container. */
function restoreTabRecords(runtimeBase) {
  try {
    const file = sessionFile(runtimeBase);
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = data.v === 2 && Array.isArray(data.tabs) ? data.tabs :
      Array.isArray(data.urls) ? data.urls.map(url => ({ url, containerId: null })) : [];
    return rows.filter(row => {
      if (!row || typeof row.url !== 'string' || row.url.length > 4096) return false;
      if (row.containerId != null && !CONTAINER_IDS.includes(row.containerId)) return false;
      try { return ['http:', 'https:'].includes(new URL(row.url).protocol); }
      catch { return false; }
    }).slice(0, MAX_RESTORE).map(row => ({ url: row.url, containerId: row.containerId || null }));
  } catch { return []; }
}

/** Legacy caller compatibility: URL-only consumers never choose a partition. */
function restoreTabs(runtimeBase) {
  return restoreTabRecords(runtimeBase).map(row => row.url);
}

/** Remove the session file (explicit close / "don't restore"). */
function clear(runtimeBase) {
  try { fs.rmSync(sessionFile(runtimeBase), { force: true }); } catch {}
}

module.exports = { captureOpenTabs, restoreTabs, restoreTabRecords, clear, sessionFile };
