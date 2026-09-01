/*
 * fingerprint-hardening.js — Phase 7 mitigations that need no engine changes.
 *
 * Strategy: STANDARDIZATION (not randomization). Random per-request values
 * make the browser MORE unique; fixed common values reduce entropy.
 *
 * Applied at app start (main.js) via Electron APIs:
 *   - User-Agent: plain Chrome on Windows (drops Forge/Electron markers)
 *
 * Page-world JavaScript shims are intentionally not injected. They either
 * require weakening the page trust boundary or interfere with subsequent
 * Chromium navigation. Engine-dependent entropy remains documented rather
 * than overstated as protected.
 */
'use strict';

// UA matches the REAL Chromium engine (process.versions.chrome) so Google
// login and other bot-detection see a consistent, existing browser version.
// Hardcoding a future version like Chrome/150 triggers "browser may not be
// secure" because the version does not exist in the wild.
const CHROME_VER = process.versions.chrome || '130.0.0.0';
const GENERIC_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

function applyAppLevelHardening(app) {
  // Generic UA for every request + navigator.userAgent in pages.
  app.userAgentFallback = GENERIC_UA;
  // Do not leak app name/version via the default Electron header set.
  try { app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint'); } catch {}
}

module.exports = { GENERIC_UA, applyAppLevelHardening };
