/*
 * fingerprint-hardening.js — Phase 7 mitigations that need no engine changes.
 *
 * Strategy: STANDARDIZATION (not randomization). Random per-request values
 * make the browser MORE unique; fixed common values reduce entropy.
 *
 * Applied at app start (main.js) via Electron APIs + PRELOAD injection into
 * every page WebContentsView:
 *   - User-Agent: plain Chrome on Windows (drops forge/Electron markers)
 *   - navigator.hardwareConcurrency -> 8
 *   - navigator.deviceMemory        -> 8
 *   - screen.* / window.outer*      -> 1920x1080x24
 *
 * NOT mitigated (engine-dependent, documented): canvas, WebGL, fonts, audio.
 */
'use strict';

// UA matches the REAL Chromium engine (process.versions.chrome) so Google
// login and other bot-detection see a consistent, existing browser version.
// Hardcoding a future version like Chrome/150 triggers "browser may not be
// secure" because the version does not exist in the wild.
const CHROME_VER = process.versions.chrome || '130.0.0.0';
const GENERIC_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

/** Script injected into every page before load (via webContents preload). */
const PAGE_HARDENING_SCRIPT = `
(() => {
  const def = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch {}
  };
  def(navigator, 'hardwareConcurrency', 8);
  def(navigator, 'deviceMemory', 8);
  const W = 1920, H = 1080, D = 24;
  for (const target of [screen, window]) {
    def(target, 'screenX', 0); def(target, 'screenY', 0);
  }
  def(screen, 'width', W);   def(screen, 'height', H);
  def(screen, 'availWidth', W); def(screen, 'availHeight', H - 40);
  def(screen, 'colorDepth', D); def(screen, 'pixelDepth', D);
  def(window, 'outerWidth', W); def(window, 'outerHeight', H);
  def(window, 'devicePixelRatio', 1);
})();`;

function applyAppLevelHardening(app) {
  // Generic UA for every request + navigator.userAgent in pages.
  app.userAgentFallback = GENERIC_UA;
  // Do not leak app name/version via the default Electron header set.
  try { app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint'); } catch {}
}

module.exports = { GENERIC_UA, PAGE_HARDENING_SCRIPT, applyAppLevelHardening };