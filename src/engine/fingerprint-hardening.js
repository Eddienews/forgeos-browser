/*
 * fingerprint-hardening.js — Phase 7 mitigations that need no engine changes.
 *
 * Strategy: STANDARDIZATION (not randomization). Random per-request values
 * make the browser MORE unique; fixed common values reduce entropy.
 *
 * Applied at app start (main.js) via Electron APIs:
 *   - User-Agent: plain Chrome on the real operating system (drops
 *     Forge/Electron markers)
 *
 * The operating system is reported truthfully. JavaScript always exposes the
 * real one (navigator.platform, navigator.userAgentData.platform) and no
 * page-world shim may change that, so headers naming a different system were
 * a contradiction any page could read: a rarer and more identifying signal
 * than the operating system itself.
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

// The platform token Chrome itself sends on each system, and the matching
// Sec-CH-UA-Platform value. Chrome reports these fixed strings regardless of
// OS version or CPU, so they add no entropy beyond the system family.
const PLATFORM_IDENTITIES = {
  win32: { uaToken: 'Windows NT 10.0; Win64; x64', clientHint: 'Windows' },
  darwin: { uaToken: 'Macintosh; Intel Mac OS X 10_15_7', clientHint: 'macOS' },
  linux: { uaToken: 'X11; Linux x86_64', clientHint: 'Linux' },
};

function platformIdentity(platform = process.platform) {
  return PLATFORM_IDENTITIES[platform] || PLATFORM_IDENTITIES.linux;
}

function genericUserAgent(platform = process.platform, chromeVersion = CHROME_VER) {
  return `Mozilla/5.0 (${platformIdentity(platform).uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/** Quoted Sec-CH-UA-Platform header value for the real operating system. */
function clientHintPlatform(platform = process.platform) {
  return `"${platformIdentity(platform).clientHint}"`;
}

const GENERIC_UA = genericUserAgent();

function applyAppLevelHardening(app) {
  // Generic UA for every request + navigator.userAgent in pages. Client hints
  // stay enabled: the session adapter sends headers that agree with the
  // navigator.userAgentData platform pages can read.
  app.userAgentFallback = GENERIC_UA;
}

module.exports = { GENERIC_UA, applyAppLevelHardening, clientHintPlatform, genericUserAgent, platformIdentity };
