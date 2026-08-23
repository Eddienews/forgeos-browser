/*
 * fingerprint.js — Phase 7: fingerprinting exposure study + mitigations.
 *
 * This prototype does NOT attempt perfect anonymity (out of scope, see
 * THREAT_MODEL.md). It documents exposure for each fingerprint channel and
 * applies mitigations the FRAMEWORK supports safely:
 *
 *   exposure                 standard   strict      ephemeral
 *   permission APIs*          ask        ask/deny    deny
 *   canvas / webgl / fonts    engine     engine      engine (documented)
 *   screen / timezone / lang  engine     engine      engine
 *   audio                     engine     engine      engine
 *   navigator props           engine     engine      engine
 *
 * * geolocation, camera, microphone, notifications, clipboard-read,
 *   midi, bluetooth, usb, serial, hid, persistent-storage, window-placement.
 *
 * Engine-dependent entropy (canvas/WebGL/fonts/audio) is NOT mitigated here:
 * safe reduction requires invasive engine changes or native addons, which
 * Phase 5/29 explicitly avoid. EVALUATED AND DOCUMENTED EXPERIMENTAL.
 */
'use strict';

const EXPOSURE_MAP = [
  { channel: 'Canvas', surface: 'toDataURL/toBlob pixel output', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'WebGL', surface: 'renderer string + extensions', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Fonts', surface: 'measureText metrics', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Screen', surface: 'screen.width/height/avail*', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Timezone', surface: 'Date.getTimezoneOffset / Intl', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Language', surface: 'navigator.language/languages', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Audio', surface: 'AudioContext fingerprint', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Hardware', surface: 'navigator.hardwareConcurrency/deviceMemory', engineDependent: true, mitigation: 'none in prototype (engine)' },
  { channel: 'Navigator', surface: 'UA, platform, plugins, mimeTypes', engineDependent: true, mitigation: 'none in prototype (engine): Electron UA is already less unique than Chrome' },
  { channel: 'Permissions', surface: 'camera/mic/location/clipboard/notifications', engineDependent: false, mitigation: 'permission-request handler: ask/deny by mode' },
  { channel: 'Storage', surface: 'localStorage/cookies persistence', engineDependent: false, mitigation: 'per-site non-persist partitions in strict/ephemeral; cookie policy blocks trackers' },
];

const PERMISSION_DEFAULTS = {
  geolocation: 'ASK',
  camera: 'ASK',
  microphone: 'ASK',
  notifications: 'ASK',
  'clipboard-read': 'ASK',
  'clipboard-sanitized-write': 'ALLOW',
  'persistent-storage': 'ASK',
  midi: 'ASK',
  bluetooth: 'ASK',
  usb: 'ASK',
  serial: 'ASK',
  hid: 'ASK',
  'window-management': 'ASK',
  media: 'ASK',
  fullscreen: 'ALLOW',
  unknown: 'DENY',
};

/** Permission handling per privacy mode: ASK → DENY in strict/ephemeral. */
function permissionFor(permission, modeId) {
  const actual = PERMISSION_DEFAULTS[permission] || PERMISSION_DEFAULTS.unknown;
  if (modeId === 'strict' || modeId === 'ephemeral') {
    // Strict never silently grants; most sensor APIs are denied rather than
    // askable (matches "fingerprinting protections increased").
    if (actual === 'ASK') return 'DENY';
  }
  return actual;
}

function exposureReport(modeId) {
  return EXPOSURE_MAP.map((e) => ({ channel: e.channel, mitigation: e.mitigation }));
}

module.exports = { EXPOSURE_MAP, PERMISSION_DEFAULTS, permissionFor, exposureReport };