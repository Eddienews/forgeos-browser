/*
 * storage-manager.js — Phase 4/5/16: site storage lifecycle & isolation.
 *
 * Policy + thin Electron wiring (lazy require of 'electron' so pure tests
 * never load the runtime).
 *
 * Isolation model (honest, framework-driven):
 *  - Standard mode, no "forget this site": default session (normal browser
 *    behavior; cross-site state is the browser engine's partitioning).
 *  - Strict / Ephemeral / "Forget this site when closed": DEDICATED
 *    non-persist session partitions, one per TAB. A tab's whole partition is
 *    wiped when the tab closes (ephemeral/forget) and never persists across
 *    app restarts (strict/ephemeral), so example-a.com state in tab A is
 *    fully isolated from example-b.com state in tab B, and scraping a site
 *    leaves no durable residue.
 *
 * Documented limitation (Phase 5): real browsers share one cookie jar with
 * SameSite partitioning; per-tab partitions are coarser — they also isolate
 * the SAME site across different tabs (a login in tab A does not carry to
 * tab B). This is a deliberately strict lab trade-off, documented in
 * ARCHITECTURE.md and SECURITY_MODEL.md.
 */
'use strict';

const crypto = require('crypto');
const { MODES } = require('./privacy-modes');

const STORAGE_TYPES = [
  'cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers',
  'websql', 'shadercache', 'filesystem',
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Registrable-ish host: last two labels when host is not an IP / localhost. */
function registrableHost(urlOrHost) {
  const h = urlOrHost && urlOrHost.includes('://') ? hostOf(urlOrHost) : String(urlOrHost || '').toLowerCase();
  if (!h) return h;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h === 'localhost' || h.endsWith('.local')) return h;
  const labels = h.split('.');
  return labels.length >= 2 ? labels.slice(-2).join('.') : h;
}

let nonce = 0;

/**
 * Which session should a tab use?
 * @returns {{ partition: string|null, ephemeral: boolean, dedicated: boolean }}
 *   partition null → Electron default session (persistent, normal browser jar)
 */
function sessionPlanFor(host, modeId, forgetOnClose = false) {
  const mode = MODES[modeId] || MODES.standard;
  const useDedicated = forgetOnClose || mode.perSitePartitions || mode.ephemeral;
  if (!useDedicated) {
    return { partition: null, ephemeral: false, dedicated: false };
  }
  nonce += 1;
  const key = (host ? registrableHost(host).replace(/[^a-z0-9.-]/g, '-') : 'tab') + '-' + nonce;
  // Never persisted: in-memory session partition, wiped on tab close.
  return { partition: `forge-tab-${key}`, ephemeral: true, dedicated: true };
}

/**
 * Clear ALL site data for a session (used on: forget-site tab close, Clear
 * Session action, Ephemeral mode exit). Needs electron at runtime.
 */
async function clearSessionData(session) {
  if (!session || typeof session.clearStorageData !== 'function') return 0;
  await session.clearStorageData({ storages: STORAGE_TYPES });
  let removed = 0;
  try {
    const cookies = await session.cookies.getAll({});
    for (const c of cookies) {
      try {
        const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        await session.cookies.remove(url, c.name);
        removed++;
      } catch {}
    }
  } catch {}
  try { await session.clearCache(); } catch {}
  return removed;
}

module.exports = { sessionPlanFor, clearSessionData, hostOf, registrableHost, STORAGE_TYPES };