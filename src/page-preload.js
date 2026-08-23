/*
 * page-preload.js — runs in EVERY page WebContentsView BEFORE page scripts.
 *
 * Unlike the chrome preload, this exposes NO bridge and NO privileges — it
 * only standardizes fingerprint-relevant values (Phase 7). With
 * contextIsolation:true the overrides live in the isolated world, which is
 * exactly what page scripts observe.
 */
'use strict';

const { contextBridge } = require('electron');

// Standardized values — see src/engine/fingerprint-hardening.js.
const W = 1920, H = 1080, D = 24;

try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true }); } catch {}
try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch {}

for (const [obj, prop, val] of [
  [screen, 'width', W], [screen, 'height', H],
  [screen, 'availWidth', W], [screen, 'availHeight', H - 40],
  [screen, 'colorDepth', D], [screen, 'pixelDepth', D],
  [window, 'outerWidth', W], [window, 'outerHeight', H],
  [window, 'devicePixelRatio', 1],
  [window, 'screenX', 0], [window, 'screenY', 0],
]) {
  try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch {}
}

// Keep the bridge surface empty: pages get nothing.
void contextBridge;