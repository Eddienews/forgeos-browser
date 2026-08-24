/*
 * site-allowlist.js — per-site blocking exemption ("disable blocking on this
 * site"). Local-first JSON next to the exe / project root. When a hostname is
 * allowlisted, the network adapter lets its requests through unfiltered and
 * the security badge shows "FRIENDLY" so the state is always visible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_PACKAGED = __dirname.includes('app.asar');
const BASE = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..', '..');
const FILE = path.join(BASE, 'forge-allowlist.json');

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = new Set(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = new Set(); }
  return cache;
}

function persist() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...load()], null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {}
}

/** Exact-host match (no wildcard subtrees: allowing a site is deliberate). */
function isAllowed(hostname) {
  return load().has(String(hostname || '').toLowerCase());
}

function add(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!h || !h.includes('.')) return { ok: false };
  load().add(h);
  persist();
  return { ok: true, host: h };
}

function remove(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  load().delete(h);
  persist();
  return { ok: true };
}

function list() { return [...load()].sort(); }

module.exports = { isAllowed, add, remove, list, FILE };