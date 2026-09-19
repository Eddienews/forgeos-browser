/*
 * agent-provider.js — the user's own inference key for the agent loop.
 *
 * ForgeOS ships a heuristic decider that needs no key at all, so the browser
 * works out of the box. This module is the opt-in upgrade: a user brings their
 * own TypeSafe (Jev) key and the /task loop starts deciding each step with a
 * model instead of a rule of thumb.
 *
 * Storage rules, and why they are not negotiable:
 *   - the key lives in its OWN file with owner-only permissions (0600), never
 *     in settings.json — that file is plain text, gets backed up, and shows up
 *     in exports;
 *   - the key is never logged, never returned by any endpoint, never written
 *     to the audit trail. `status()` reports only whether one exists and a
 *     short hint, never the value;
 *   - it is bound to the provider's origin, so it cannot be sent elsewhere.
 *
 * The key is the user's, not the project's: nothing here phones home.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = 'forge-inference-key';
const ENV_VAR = 'FORGE_TYPESAFE_API_KEY';

/** Known providers. One endpoint each; the key is validated against the shape. */
const PROVIDERS = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe (Jev)',
    origin: 'https://api.typesafe.ai',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    // Console: https://console.typesafe.ai/settings/keys
    keyPattern: /^sk-[A-Za-z0-9_\-]{12,}$/,
    keyHint: 'sk-…',
    docs: 'https://console.typesafe.ai/settings/keys',
  },
};

/**
 * Write the key with owner-only permissions, atomically.
 * Mirrors the Agent API's token writer: temporary file + rename, so a crash
 * never leaves a half-written secret on disk.
 */
function writePrivateKeyFile(filePath, contents, { fileSystem = fs, platform = process.platform } = {}) {
  const temporary = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
    if (platform !== 'win32') fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporary, filePath);
    if (platform !== 'win32') fileSystem.chmodSync(filePath, 0o600);
  } catch (error) {
    try { if (descriptor !== undefined) fileSystem.closeSync(descriptor); } catch {}
    try { fileSystem.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/** Reject anything that is not plausibly a key for this provider. */
function validateKey(providerId, rawKey) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { ok: false, reason: `unknown provider "${providerId}"` };
  const key = String(rawKey == null ? '' : rawKey).trim();
  if (!key) return { ok: false, reason: 'key is empty' };
  if (key.length > 400) return { ok: false, reason: 'key is implausibly long' };
  if (/\s/.test(key)) return { ok: false, reason: 'key contains whitespace' };
  if (!provider.keyPattern.test(key)) {
    return { ok: false, reason: `key does not look like a ${provider.label} key (expected ${provider.keyHint})` };
  }
  return { ok: true, key };
}

/** Short, non-revealing form for the UI: first 3 + last 2 characters. */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

function keyPathFor(baseDir) {
  return path.join(baseDir, KEY_FILE);
}

/**
 * Read the stored key, if any. The environment variable wins when set, so a
 * user can run the browser non-interactively without a secret on disk.
 */
function readKey(baseDir, { env = process.env, fileSystem = fs } = {}) {
  const fromEnv = env[ENV_VAR];
  if (fromEnv && String(fromEnv).trim()) {
    return { source: 'env', key: String(fromEnv).trim() };
  }
  try {
    const raw = fileSystem.readFileSync(keyPathFor(baseDir), 'utf8');
    // Tolerate "provider=...\nkey=..." and a bare key.
    const m = /^key=(.+)$/m.exec(raw);
    const key = (m ? m[1] : raw).trim();
    if (!key) return { source: null, key: null };
    const p = /^provider=(.+)$/m.exec(raw);
    return { source: 'file', provider: p ? p[1].trim() : 'typesafe', key };
  } catch {
    return { source: null, key: null };
  }
}

/** Save a key after validation. Returns a report that never contains the key. */
function saveKey(baseDir, providerId, rawKey, { fileSystem = fs, platform = process.platform } = {}) {
  const check = validateKey(providerId, rawKey);
  if (!check.ok) return { ok: false, reason: check.reason };
  try {
    writePrivateKeyFile(keyPathFor(baseDir), `provider=${providerId}\nkey=${check.key}\n`, { fileSystem, platform });
  } catch (error) {
    return { ok: false, reason: `could not write the key file: ${String((error && error.message) || error).slice(0, 120)}` };
  }
  return { ok: true, provider: providerId, hint: maskKey(check.key) };
}

/** Remove the stored key. The environment variable, if set, still applies. */
function clearKey(baseDir, { fileSystem = fs } = {}) {
  try {
    fileSystem.unlinkSync(keyPathFor(baseDir));
    return { ok: true, removed: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, reason: String((error && error.message) || error).slice(0, 120) };
  }
}

/**
 * What the UI may know: whether a key exists, where it came from, and a hint.
 * Deliberately no value — this object is safe to render and to log.
 */
function status(baseDir, { env = process.env, fileSystem = fs } = {}) {
  const found = readKey(baseDir, { env, fileSystem });
  if (!found.key) {
    return {
      configured: false, source: null, provider: null, hint: null,
      providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, docs: p.docs, keyHint: p.keyHint })),
    };
  }
  const providerId = found.source === 'env' ? 'typesafe' : (found.provider || 'typesafe');
  const provider = PROVIDERS[providerId] || PROVIDERS.typesafe;
  return {
    configured: true,
    source: found.source,
    provider: providerId,
    providerLabel: provider.label,
    hint: maskKey(found.key),
    model: provider.model,
    // A key from the environment cannot be edited from the UI.
    editable: found.source === 'file',
    providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, docs: p.docs, keyHint: p.keyHint })),
  };
}

module.exports = {
  PROVIDERS, ENV_VAR, KEY_FILE,
  validateKey, maskKey, writePrivateKeyFile,
  readKey, saveKey, clearKey, status, keyPathFor,
};
