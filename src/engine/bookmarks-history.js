/*
 * bookmarks-history.js — local bookmarks + session history for ForgeOS
 * Browser (v0.2). Local-first: JSON file next to the exe when packaged,
 * project root in dev. Never leaves the machine; no sync, no telemetry.
 *
 * Bookmarks : [{ id, title, url, addedAt }]           (persistent)
 * History   : [{ id, title, url, visitedAt }]          (session-scoped ring,
 *             cleared by Clear Session; capped)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_PACKAGED = __dirname.includes('app.asar');
const BASE = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..', '..');

const BOOKMARKS_FILE = path.join(BASE, 'forge-bookmarks.json');
const HISTORY_FILE = path.join(BASE, 'forge-history.json');

const HISTORY_CAP = 500;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let idSeq = Date.now();
const nextId = () => 'b' + (++idSeq).toString(36);

/* ------------------------- bookmarks ------------------------- */

function listBookmarks() {
  return readJson(BOOKMARKS_FILE, []);
}

function addBookmark({ title, url }) {
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: 'invalid url' };
  const items = listBookmarks();
  if (items.some((b) => b.url === url)) return { ok: true, duplicate: true, items };
  const entry = { id: nextId(), title: String(title || url).slice(0, 200), url, addedAt: new Date().toISOString() };
  items.unshift(entry);
  writeJsonAtomic(BOOKMARKS_FILE, items.slice(0, 1000));
  return { ok: true, item: entry };
}

function removeBookmark(id) {
  const items = listBookmarks().filter((b) => b.id !== id);
  writeJsonAtomic(BOOKMARKS_FILE, items);
  return { ok: true };
}

/** Is this URL bookmarked? (used to render ★ state) */
function isBookmarked(url) {
  return listBookmarks().some((b) => b.url === url);
}

/* -------------------------- history -------------------------- */

let historyCache = null;

function listHistory() {
  if (!historyCache) historyCache = readJson(HISTORY_FILE, []);
  return historyCache;
}

function addHistory({ title, url }) {
  if (!url || !/^https?:/i.test(url)) return;
  const items = listHistory();
  // Collapse consecutive duplicates (SPA navigations, reloads).
  if (items[0] && items[0].url === url) {
    items[0].visitedAt = new Date().toISOString();
  } else {
    items.unshift({ id: nextId(), title: String(title || url).slice(0, 200), url, visitedAt: new Date().toISOString() });
  }
  if (items.length > HISTORY_CAP) items.length = HISTORY_CAP;
  historyCache = items;
  // Persist lazily but promptly; cheap at this size.
  try { writeJsonAtomic(HISTORY_FILE, items); } catch {}
}

function removeFromHistory(id) {
  historyCache = listHistory().filter((h) => h.id !== id);
  writeJsonAtomic(HISTORY_FILE, historyCache);
  return { ok: true };
}

function clearHistory() {
  historyCache = [];
  try { writeJsonAtomic(HISTORY_FILE, []); } catch {}
  return { ok: true };
}

module.exports = {
  listBookmarks, addBookmark, removeBookmark, isBookmarked,
  listHistory, addHistory, removeFromHistory, clearHistory,
  BOOKMARKS_FILE, HISTORY_FILE,
};