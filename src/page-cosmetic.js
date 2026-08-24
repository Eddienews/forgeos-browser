/*
 * cosmetic-preload.js — runs at document_start in every page view.
 *
 * Receives, via electron IPC (context bridge is NOT used here; the page
 * preload gets data injected by main through webContents.executeJavaScript
 * in an isolated world before page scripts run), two things:
 *   - genericCss  : one stylesheet with all generic "##selector" hides
 *   - hostSelectors: selectors for THIS page's domain
 *
 * It injects a <style> that hides matching elements. Display none via CSS
 * cannot leak page data anywhere; it only changes rendering.
 */
'use strict';

(function () {
  // Data arrives as global vars set in this isolated world before this file
  // executes (see main.js injectCosmetic()).
  const css = [
    typeof __FORGE_GENERIC_CSS__ !== 'undefined' ? __FORGE_GENERIC_CSS__ : '',
    ...(typeof __FORGE_HOST_SELECTORS__ !== 'undefined' ? __FORGE_HOST_SELECTORS__ : []),
  ].filter(Boolean).map((s) => `${s}{display:none!important}`).join('\n');

  if (!css) return;
  try {
    const style = document.createElement('style');
    style.setAttribute('data-forge', 'cosmetic');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch {}
})();