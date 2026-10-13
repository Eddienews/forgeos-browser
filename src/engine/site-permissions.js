/*
 * site-permissions.js — the user's remembered permission decisions per site.
 *
 * The permission policy (fingerprint.js) says which capabilities may be asked
 * for at all. This module remembers what the user answered for one exact
 * origin, so a trusted site is not asked again and a refused site stays
 * refused. It never widens the policy: a remembered "allow" applies only to a
 * permission the active privacy mode would otherwise ASK for.
 *
 * Shape on disk: { "<origin>": { "<permission>": "allow" | "deny" } }
 * "ask" is the absence of an entry. Local-first, owner-only, never synced.
 */
'use strict';

const fs = require('fs');
const { dataFile, writePrivateAtomic } = require('./settings');

const FILE = dataFile('forge-permissions.json');

/** Permissions the user can manage per site, in display order. */
const MANAGED_PERMISSIONS = Object.freeze({
  media: 'Camera and microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Read clipboard',
});

const STATES = new Set(['ask', 'allow', 'deny']);
const MAX_ORIGINS = 2000;

/** Exact http(s) origin, or null. Opaque and credentialed URLs never qualify. */
function siteOrigin(urlOrOrigin) {
  if (typeof urlOrOrigin !== 'string' || /[\u0000-\u001f\u007f]/.test(urlOrOrigin)) return null;
  try {
    const u = new URL(urlOrOrigin);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

function isManaged(permission) {
  return typeof permission === 'string' && Object.hasOwn(MANAGED_PERMISSIONS, permission);
}

/** Keep only well-formed entries: a damaged or edited file never grants more. */
function sanitize(raw) {
  const clean = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  for (const [key, entry] of Object.entries(raw)) {
    if (clean.size >= MAX_ORIGINS) break;
    const origin = siteOrigin(key);
    if (!origin || origin !== key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const decisions = {};
    for (const [permission, state] of Object.entries(entry)) {
      if (isManaged(permission) && (state === 'allow' || state === 'deny')) decisions[permission] = state;
    }
    if (Object.keys(decisions).length) clean.set(origin, decisions);
  }
  return clean;
}

function createStore({ file = FILE, fileSystem = fs, write = writePrivateAtomic } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try { cache = sanitize(JSON.parse(fileSystem.readFileSync(file, 'utf8'))); }
    catch { cache = new Map(); }
    return cache;
  }

  /** "allow", "deny", or null when the site has no remembered decision. */
  function get(urlOrOrigin, permission) {
    const origin = siteOrigin(urlOrOrigin);
    if (!origin || !isManaged(permission)) return null;
    const entry = load().get(origin);
    return (entry && entry[permission]) || null;
  }

  /** Persist first; memory changes only after the file is safely written. */
  function set(urlOrOrigin, permission, state) {
    const origin = siteOrigin(urlOrOrigin);
    if (!origin) return { ok: false, reason: 'Not an HTTP(S) site.' };
    if (!isManaged(permission)) return { ok: false, reason: 'Unsupported permission.' };
    if (!STATES.has(state)) return { ok: false, reason: 'Unsupported permission state.' };
    const next = new Map([...load()].map(([key, entry]) => [key, { ...entry }]));
    const entry = next.get(origin) || {};
    if (state === 'ask') delete entry[permission];
    else entry[permission] = state;
    if (Object.keys(entry).length) next.set(origin, entry);
    else next.delete(origin);
    if (next.size > MAX_ORIGINS) return { ok: false, reason: 'Too many remembered sites; reset some first.' };
    try {
      write(file, JSON.stringify(Object.fromEntries(next), null, 2));
    } catch (error) {
      return { ok: false, reason: `Unable to save site permission: ${String((error && error.message) || error).slice(0, 120)}` };
    }
    cache = next;
    return { ok: true, origin, permission, state };
  }

  /** Every managed permission for one site, in display order. */
  function list(urlOrOrigin) {
    const origin = siteOrigin(urlOrOrigin);
    const entry = (origin && load().get(origin)) || {};
    return Object.entries(MANAGED_PERMISSIONS).map(([permission, label]) => ({
      permission, label, state: entry[permission] || 'ask',
    }));
  }

  return { get, set, list };
}

const defaultStore = createStore();

module.exports = {
  FILE, MANAGED_PERMISSIONS, createStore, isManaged, siteOrigin,
  get: defaultStore.get, set: defaultStore.set, list: defaultStore.list,
};
