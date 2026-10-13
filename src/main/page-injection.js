/*
 * page-injection.js — what the browser itself adds to a page view: cosmetic
 * ad-hiding rules, removal of matched ad elements, and its own scrollbar style.
 *
 * Everything here goes through insertCSS / executeJavaScript on the tab's
 * webContents. The page receives no bridge, and selectors are data: they are
 * serialized with JSON.stringify, never concatenated into script.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('../engine/settings');
const allowlist = require('../engine/site-allowlist');
const { compileCosmetic, selectorsForHost } = require('../engine/cosmetic-engine');
const { DARK_SCROLLBAR_CSS, supportsPageAppearance } = require('../engine/page-appearance');
const { pageProcessingPolicy } = require('../engine/page-processing-policy');

/** @param {{logger: {log: Function}}} ctx */
function createPageInjection(ctx) {
  const log = ctx.logger;

  /* Cosmetic filtering (v0.4): compile "##" rules once at startup; inject a
   * stylesheet into every page before its scripts run. Toggled by settings. */
  let cosmetic = null;
  function initCosmetic() {
    try {
      const lines = [];
      // Lists live inside the asar when packaged: <asar>/src → <asar>/lists.
      const listsDir = __dirname.includes('app.asar')
        ? path.join(__dirname, '..', '..', 'lists')
        : path.join(__dirname, '..', '..', 'lists');
      for (const f of ['easylist.txt', 'easyprivacy.txt']) {
        const p = path.join(listsDir, f);
        if (!fs.existsSync(p)) continue;
        for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
          if (l.includes('##') || l.includes('#@#')) lines.push(l);
        }
      }
      cosmetic = compileCosmetic(lines);
      log.log('INFO', 'cosmetic rules compiled', cosmetic.stats);
    } catch (e) {
      log.log('ERROR', 'cosmetic compile failed', { error: String(e).slice(0, 150) });
      cosmetic = { genericCss: '', byDomain: new Map(), stats: {} };
    }
  }

  /** Apply browser-owned visual chrome to web content without a page preload. */
  function injectPageAppearance(tab, url) {
    if (!tab || !supportsPageAppearance(url)) return;
    tab.wc.insertCSS(DARK_SCROLLBAR_CSS, { cssOrigin: 'user' }).catch(() => {});
  }

  /** Inject cosmetic CSS into a page view (native insertCSS — no JS cost). */
  function injectCosmetic(tab, url) {
    if (!cosmetic || !tab || !url.startsWith('http')) return;
    try {
      if (settings.all().blockAds === false) return; // user toggle respected
      let host = '';
      try { host = new URL(url).hostname; } catch {}
      // Per-site allowlist also disables cosmetic hiding.
      if (host && allowlist.isAllowed(host)) return;
      const hostSelectors = selectorsForHost(cosmetic, host);
      const css = [
        cosmetic.genericCss,
        ...hostSelectors.map((s) => `${s}{display:none!important}`),
      ].filter(Boolean).join('\n');
      if (!css) return;
      tab.wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
    } catch {}
  }

  /** DOM removal pass: DELETE matched elements (testers score "removed" > hidden). */
  function injectDomRemoval(tab, url) {
    if (!cosmetic || !tab || !url.startsWith('http')) return;
    try {
      if (!pageProcessingPolicy(url).allowDomRemoval) return;
      if (settings.all().blockAds === false) return;
      let host = '';
      try { host = new URL(url).hostname; } catch {}
      if (host && allowlist.isAllowed(host)) return;
      const hostSelectors = selectorsForHost(cosmetic, host);
      const generic = cosmetic.genericSelectors || [];
      const selectors = [...new Set([...generic, ...hostSelectors])]
        .filter((s) => s && s.length < 200 && !/[:{}]/.test(s)) // safe subset only
        .slice(0, 4000);
      if (!selectors.length) return;
      const js = `(function(){
        let removed = 0;
        for (const sel of ${JSON.stringify(selectors)}) {
          try {
            document.querySelectorAll(sel).forEach(el => {
              if (el && el.parentNode) { el.parentNode.removeChild(el); removed++; }
            });
          } catch {}
        }
        return removed;
      })()`;
      tab.wc.executeJavaScript(js, true).catch(() => {});
    } catch {}
  }

  return { initCosmetic, injectPageAppearance, injectCosmetic, injectDomRemoval };
}

module.exports = { createPageInjection };
