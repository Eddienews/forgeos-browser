/*
 * site-allowlist.js — per-site blocking exemption ("disable blocking on this
 * site"). Local-first JSON next to the exe / project root. When a hostname is
 * allowlisted, the network adapter lets its requests through unfiltered and
 * the security badge shows "FRIENDLY" so the state is always visible.
 *
 * v0.6: TRUST PRESETS — the user decides to trust a whole service ecosystem
 * (e.g. Google: accounts, youtube, drive, gmail, gstatic) with one action.
 * Trusting is deliberate and reversible; presets only ever ADD hosts that
 * belong to the named provider.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_PACKAGED = __dirname.includes('app.asar');
const BASE = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..', '..');
const FILE = path.join(BASE, 'forge-allowlist.json');

/** Provider ecosystems: one user decision → all essential hosts released. */
const TRUST_PRESETS = {
  google: [
    'google.com', 'accounts.google.com', 'play.google.com',
    'youtube.com', 'www.youtube.com', 'youtu.be', 'ytimg.com',
    'googlevideo.com', 'gstatic.com', 'ggpht.com',
    'googleusercontent.com', 'drive.google.com', 'docs.google.com',
    'mail.google.com', 'gmail.com',
  ],
  microsoft: [
    'microsoft.com', 'live.com', 'office.com', 'office365.com',
    'microsoftonline.com', 'outlook.com', 'onedrive.live.com',
  ],
  apple: [
    'apple.com', 'icloud.com', 'mzstatic.com',
  ],
  social: [
    'facebook.com', 'instagram.com', 'whatsapp.com', 'x.com', 'twitter.com',
    'linkedin.com', 'reddit.com', 'tiktok.com', 'cdninstagram.com',
    'fbcdn.net', 'twimg.com',
  ],
};

let cache = null;
let presetsCache = null; // { presetName: [hosts] }

function load() {
  if (cache) return cache;
  try { cache = new Set(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = new Set(); }
  return cache;
}

function loadPresets() {
  if (presetsCache) return presetsCache;
  try { presetsCache = JSON.parse(fs.readFileSync(FILE + '.presets', 'utf8')); } catch { presetsCache = {}; }
  return presetsCache;
}

function persist() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...load()], null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {}
}

function persistPresets() {
  try {
    const tmp = FILE + '.presets.tmp';
    fs.writeFileSync(tmp, JSON.stringify(loadPresets(), null, 2), 'utf8');
    fs.renameSync(tmp, FILE + '.presets');
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
  // Also drop the host from any preset record so re-trust works cleanly.
  for (const [name, hosts] of Object.entries(loadPresets())) {
    loadPresets()[name] = hosts.filter((x) => x !== h);
  }
  persistPresets();
  persist();
  return { ok: true };
}

/**
 * Apply a trust preset: add every preset host to the allowlist.
 * Returns the hosts newly added (already-present ones are skipped).
 */
function applyPreset(name) {
  const hosts = TRUST_PRESETS[name];
  if (!hosts) return { ok: false, error: `unknown preset '${name}'` };
  const added = [];
  for (const h of hosts) {
    if (!load().has(h)) { load().add(h); added.push(h); }
  }
  if (added.length) {
    loadPresets()[name] = [...new Set([...(loadPresets()[name] || []), ...added])];
    persistPresets();
    persist();
  }
  return { ok: true, preset: name, addedCount: added.length, added };
}

/** Revoke a whole preset: removes exactly the hosts it had added. */
function revokePreset(name) {
  const applied = loadPresets()[name];
  if (!applied || !applied.length) return { ok: false, error: `preset '${name}' not active` };
  for (const h of applied) load().delete(h);
  delete loadPresets()[name];
  persistPresets();
  persist();
  return { ok: true, revokedCount: applied.length };
}

/** Which presets are currently active (partially or fully)? */
function activePresets() {
  const out = {};
  for (const [name, applied] of Object.entries(loadPresets())) {
    if (applied && applied.length) out[name] = applied.length;
  }
  return out;
}

function list() { return [...load()].sort(); }

module.exports = {
  isAllowed, add, remove, list, FILE,
  applyPreset, revokePreset, activePresets,
  TRUST_PRESETS,
};