/*
 * page-appearance.js — browser-owned visual defaults for web content.
 *
 * This is native user CSS only. It does not expose a preload, JavaScript
 * bridge, or additional capability to untrusted pages.
 */
'use strict';

const DARK_SCROLLBAR_CSS = `
:root {
  scrollbar-color: rgba(236, 227, 212, 0.32) rgba(18, 16, 13, 0.82) !important;
}
::-webkit-scrollbar {
  width: 10px !important;
  height: 10px !important;
}
::-webkit-scrollbar-track {
  background: rgba(18, 16, 13, 0.82) !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(236, 227, 212, 0.28) !important;
  border: 2px solid rgba(18, 16, 13, 0.82) !important;
  border-radius: 999px !important;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(232, 163, 61, 0.58) !important;
}
`;

function supportsPageAppearance(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { DARK_SCROLLBAR_CSS, supportsPageAppearance };
