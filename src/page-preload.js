/*
 * page-preload.js — runs in EVERY page WebContentsView BEFORE page scripts.
 *
 * Unlike the chrome preload, this exposes NO bridge and NO privileges — it
 * only standardizes fingerprint-relevant surfaces (Phase 7).
 *
 * Strategy: STANDARDIZATION + light deterministic noise. Never per-request
 * randomization (that makes the browser MORE unique, see THREAT_MODEL.md).
 *
 * Levels (settings.fingerprint):
 *   'off'      → nothing is overridden
 *   'reduced'  → hardware/screen standardization only
 *   'standard' → + canvas noise, WebGL vendor/renderer mask, audio noise
 *
 * The level arrives via the __FORGE_FP_LEVEL__ global set by main.js before
 * this script executes in the same isolated world.
 */
'use strict';

(function () {
  // Read the fingerprint level from disk (written by main on navigation).
  // In the main world with nodeIntegration:false, process is unavailable;
  // use a synchronous XHR-free approach: level defaults to 'standard'.
  let LEVEL = 'standard';
  try {
    const req = new XMLHttpRequest();
    req.open('GET', 'file:///__forge_fp_probe__', false); // never fetched; placeholder
    void req;
  } catch {}
  try {
    // Electron exposes process.versions in preloads even without nodeIntegration
    // only when sandbox:false AND contextIsolation:false — here we are in that mode,
    // but we deliberately avoid Node APIs in page scope. Level comes from the
    // __FORGE_FP_LEVEL__ global set by an earlier preload statement if present.
    if (typeof __FORGE_FP_LEVEL__ !== 'undefined') LEVEL = __FORGE_FP_LEVEL__;
    else if (typeof window.__FORGE_FP_LEVEL__ !== 'undefined') LEVEL = window.__FORGE_FP_LEVEL__;
  } catch {}
  if (LEVEL === 'off') return;

  /* ---- hardware & screen standardization (all levels) ---- */
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  } catch {}

  // Screen: report a common desktop geometry instead of the real window size.
  // Note: this changes window.screen; pages using it for layout may look odd,
  // which is acceptable for a lab browser and configurable to 'reduced'.
  if (LEVEL !== 'reduced') {
    try {
      const fake = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
      for (const [k, v] of Object.entries(fake)) {
        Object.defineProperty(screen, k, { get: () => v, configurable: true });
      }
    } catch {}
  }

  if (LEVEL === 'reduced') return;

  /* ---- deterministic noise seed from the site origin ----
   * Same site → same noise every visit (stable UX); different sites get
   * different noise, so cross-site canvas hashes do not match. */
  function seedFromOrigin() {
    let h = 2166136261;
    const s = String(location.origin || 'file://');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const SEED = seedFromOrigin();
  function prng() { // mulberry32
    SEED; // captured
    let a = SEED;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- canvas noise (standard) ---- */
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    function perturb(ctx, w, h) {
      try {
        const img = origGetImageData.call(ctx, 0, 0, w, h);
        const rand = prng();
        const d = img.data;
        // Touch ~2% of pixels by ±1 in one channel: invisible, breaks hashes.
        for (let i = 0; i < d.length; i += 4 * 37) {
          d[i] = Math.max(0, Math.min(255, d[i] + (rand() > 0.5 ? 1 : -1)));
        }
        ctx.putImageData(img, 0, 0);
      } catch {}
    }

    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try {
        if (this.width && this.height) {
          const ctx = this.getContext('2d');
          if (ctx) perturb(ctx, this.width, this.height);
        }
      } catch {}
      return origToDataURL.apply(this, args);
    };

    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      try {
        if (this.width && this.height) {
          const ctx = this.getContext('2d');
          if (ctx) perturb(ctx, this.width, this.height);
        }
      } catch {}
      return origToBlob.call(this, cb, ...rest);
    };

    CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h, ...rest) {
      const img = origGetImageData.call(this, x, y, w, h, ...rest);
      if (LEVEL === 'standard') {
        try {
          const rand = prng();
          const d = img.data;
          for (let i = 0; i < d.length; i += 4 * 53) {
            d[i] = Math.max(0, Math.min(255, d[i] + (rand() > 0.5 ? 1 : -1)));
          }
        } catch {}
      }
      return img;
    };
  } catch {}

  /* ---- WebGL vendor/renderer mask (standard) ---- */
  try {
    const patchGL = (proto) => {
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        try {
          // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
          if (p === 0x9245 || p === 0x9246) {
            return p === 0x9245 ? 'Google Inc. (Intel)' : 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          }
        } catch {}
        return orig.call(this, p);
      };
    };
    if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);
  } catch {}

  /* ---- AudioContext noise (standard): tiny deterministic sample tweak ---- */
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && AC.prototype && !AC.prototype.__forgePatched) {
      const origGetChannel = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (ch, ...rest) {
        const data = origGetChannel.call(this, ch, ...rest);
        if (LEVEL === 'standard') {
          try {
            const rand = prng();
            for (let i = 0; i < data.length; i += 501) {
              data[i] += (rand() - 0.5) * 1e-7;
            }
          } catch {}
        }
        return data;
      };
      AC.prototype.__forgePatched = true;
    }
  } catch {}
})();