/*
 * settings.js — persistent user settings for ForgeOS Browser (v0.2).
 *
 * Stored as JSON next to the executable when packaged, in the project root
 * when running from source. Loaded at startup; every write is atomic-ish
 * (write temp + rename). No telemetry; the file never leaves the machine.
 *
 * Shape:
 * {
 *   mode: 'standard'|'strict'|'ephemeral',
 *   blockAds: true,
 *   blockThirdPartyCookies: true,
 *   stripTrackingParams: true,
 *   fingerprint: 'standard'|'reduced'|'off', // reserved for a sandbox-safe implementation
 *   subtitleLangs: 'en.*,pt.*',
 *   pageZoom: 100,
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_PACKAGED = __dirname.includes('app.asar');
const BASE = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..', '..');

const SETTINGS_FILE = path.join(BASE, 'forge-settings.json');

const DEFAULTS = {
  mode: 'standard',
  blockAds: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  // Retained for settings-file compatibility; no page-world shims are
  // installed until a sandbox-safe, navigation-safe implementation exists.
  fingerprint: 'standard',
  subtitleLangs: 'en.*,pt.*',
  pageZoom: 100,
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
    cache = next;
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
  return { ok: true, settings: next };
}

function all() { return load(); }

module.exports = { load, save, all, DEFAULTS, SETTINGS_FILE };
