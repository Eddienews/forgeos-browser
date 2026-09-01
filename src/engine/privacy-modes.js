/*
 * privacy-modes.js — Phase 22: Standard / Strict / Ephemeral.
 *
 * These modes reduce tracking; they are NOT anonymity modes and must never
 * be described as such (see THREAT_MODEL.md "Out of Scope").
 *
 * Pure policy data + helpers. The Electron layer maps these to sessions,
 * webRequest filters, and storage partitions.
 * `fingerprint` values are retained as forward-compatible policy metadata;
 * page-world shims stay disabled until the TODO.md safety checks are met.
 */
'use strict';

const MODES = {
  standard: {
    id: 'standard',
    label: 'Standard',
    summary:
      'Ads blocked, trackers blocked, third-party cookies blocked, persistent first-party cookies allowed.',
    blockThirdPartyCookies: true,
    blockPersistentCookies: false,
    restrictThirdPartyResources: false,
    fingerprint: 'standard',
    ephemeral: false,
    retainHistory: true,
    perSitePartitions: false, // normal single session
  },
  strict: {
    id: 'strict',
    label: 'Strict',
    summary:
      'Ads blocked, trackers blocked, most third-party resources restricted, persistent storage reduced, fingerprinting protections increased.',
    blockThirdPartyCookies: true,
    blockPersistentCookies: true,
    restrictThirdPartyResources: true,
    fingerprint: 'reduced',
    ephemeral: false,
    retainHistory: true,
    perSitePartitions: true, // per-site session partitions (storage isolation)
  },
  ephemeral: {
    id: 'ephemeral',
    label: 'Ephemeral',
    summary:
      'Everything temporary. Session removed on close, no browsing history retained, no persistent cookies. Not anonymous.',
    blockThirdPartyCookies: true,
    blockPersistentCookies: true,
    restrictThirdPartyResources: true,
    fingerprint: 'reduced-plus',
    ephemeral: true,
    retainHistory: false,
    perSitePartitions: true,
  },
};

function describe(modeId) {
  const m = MODES[modeId] || MODES.standard;
  return `${m.label}: ${m.summary}`;
}

function isValidMode(modeId) {
  return Object.prototype.hasOwnProperty.call(MODES, modeId);
}

module.exports = { MODES, describe, isValidMode };
