/*
 * settings.js — persistent user settings for ForgeOS Browser (v0.2).
 *
 * Stored as JSON in the OS user-data directory when packaged (next to the
 * executable only in portable mode), in the project root when running from
 * source. Loaded at startup; every write is atomic-ish
 * (write temp + rename). No telemetry; the file never leaves the machine.
 *
 * Shape:
 * {
 *   mode: 'standard'|'strict'|'ephemeral',
 *   blockAds: true,
 *   blockThirdPartyCookies: true,
 *   stripTrackingParams: true,
 *   httpsOnly: true,
 *   fingerprint: 'standard'|'reduced'|'off', // reserved for a sandbox-safe implementation
 *   subtitleLangs: 'en.*,pt.*',
 *   pageZoom: 100,
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_PACKAGED = __dirname.includes('app.asar');

/**
 * Directory for private user data. Mirrors main.js getRuntimeBase(): the
 * project root in dev, the executable directory only in portable mode, and the
 * OS user-data directory otherwise. An installed build's executable directory
 * may be read-only or shared between accounts, so it never holds user data.
 */
function resolveDataDir({
  packaged = IS_PACKAGED, execPath = process.execPath, fileSystem = fs,
  userData = () => require('electron').app.getPath('userData'),
} = {}) {
  if (!packaged) return path.join(__dirname, '..', '..');
  const exeDir = path.dirname(execPath);
  if (fileSystem.existsSync(path.join(exeDir, '.portable'))) return exeDir;
  try {
    const dir = userData();
    if (dir && typeof dir === 'string') return dir;
  } catch {}
  return exeDir;
}

/**
 * Path of one private data file. Earlier packaged builds wrote these next to
 * the executable; such a file is moved once into the data directory.
 */
function dataFile(name, options = {}) {
  const { packaged = IS_PACKAGED, execPath = process.execPath, fileSystem = fs } = options;
  const dir = resolveDataDir(options);
  const file = path.join(dir, name);
  if (!packaged) return file;
  const legacy = path.join(path.dirname(execPath), name);
  if (legacy === file) return file;
  try {
    if (!fileSystem.existsSync(file) && fileSystem.existsSync(legacy)) {
      writePrivateAtomic(file, fileSystem.readFileSync(legacy, 'utf8'), { fileSystem });
      try { fileSystem.rmSync(legacy, { force: true }); } catch {}
    }
  } catch {}
  return file;
}

/** Atomic replace with owner-only permissions (history, exceptions, settings). */
function writePrivateAtomic(file, text, { fileSystem = fs, platform = process.platform } = {}) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  try {
    fileSystem.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    // An existing temporary file keeps its old mode; enforce it explicitly.
    if (platform !== 'win32') fileSystem.chmodSync(tmp, 0o600);
    fileSystem.renameSync(tmp, file);
  } catch (error) {
    try { fileSystem.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

const SETTINGS_FILE = dataFile('forge-settings.json');

const DEFAULTS = {
  mode: 'standard',
  blockAds: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  // Retry http:// navigations over https://; ask before falling back.
  httpsOnly: true,
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
    writePrivateAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
    cache = next;
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
  return { ok: true, settings: next };
}

function all() { return load(); }

module.exports = { load, save, all, DEFAULTS, SETTINGS_FILE, resolveDataDir, dataFile, writePrivateAtomic };
