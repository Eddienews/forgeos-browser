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

/*
 * Client-hint brands. Electron sends no Sec-CH-UA headers by itself, while
 * navigator.userAgentData reports the engine's own brand list to every page.
 * Headers that name a different browser are a contradiction a page can read,
 * so the headers repeat exactly what the engine reports. The list is learned
 * once from the trusted toolbar renderer, which runs the same engine.
 */
let engineBrands = null;

function cleanBrandList(list) {
  if (!Array.isArray(list) || !list.length || list.length > 8) return null;
  const out = [];
  for (const item of list) {
    const brand = item && item.brand, version = item && item.version;
    // Structured-header strings: printable ASCII without quote or backslash.
    if (typeof brand !== 'string' || !/^[\x20\x21\x23-\x5b\x5d-\x7e]{1,40}$/.test(brand)) return null;
    if (typeof version !== 'string' || !/^\d{1,5}(?:\.\d{1,6}){0,3}$/.test(version)) return null;
    out.push({ brand, version });
  }
  return out;
}

const formatBrandList = (list) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

/** Record the engine's brand lists. Returns false, changing nothing, if malformed. */
function setEngineBrands(reported) {
  const brands = cleanBrandList(reported && reported.brands);
  const full = cleanBrandList(reported && reported.fullVersionList);
  if (!brands) return false;
  engineBrands = { brands: formatBrandList(brands), fullVersionList: full ? formatBrandList(full) : null };
  return true;
}

/** { brands, fullVersionList } header values, or null until the engine reported them. */
function engineClientHints() { return engineBrands; }

/** Client hints are sent only to secure origins, as browsers do. */
function sendsClientHints(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || (u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost')));
  } catch {
    return false;
  }
}

function applyAppLevelHardening(app) {
  // Generic UA for every request + navigator.userAgent in pages. Client hints
  // stay enabled: the session adapter sends headers that agree with the
  // navigator.userAgentData platform pages can read.
  app.userAgentFallback = GENERIC_UA;
}

module.exports = {
  GENERIC_UA, applyAppLevelHardening, clientHintPlatform, genericUserAgent, platformIdentity,
  engineClientHints, sendsClientHints, setEngineBrands,
};
