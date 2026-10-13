/*
 * view-layout.js — pure browser content bounds calculation.
 *
 * Electron WebContentsView content is composited above the chrome renderer.
 * When a chrome menu is open, the page must not occupy the same pixels.
 */
'use strict';

function browserViewBounds({ width, height, toolbarHeight = 42, rightInset = 0, minPageWidth = 320 } = {}) {
  const safeWidth = Math.max(0, Math.floor(Number(width) || 0));
  const safeHeight = Math.max(0, Math.floor(Number(height) || 0));
  const bar = Math.max(0, Math.min(safeHeight, Math.floor(Number(toolbarHeight) || 0)));
  const requestedInset = Math.max(0, Math.floor(Number(rightInset) || 0));
  const maxInset = Math.max(0, safeWidth - Math.max(0, Math.floor(Number(minPageWidth) || 0)));
  const inset = Math.min(requestedInset, maxInset);

  return {
    x: 0,
    y: bar,
    width: safeWidth - inset,
    height: Math.max(0, safeHeight - bar),
  };
}

const POPUP_INPUT_WINDOW_MS = 1500;
const POPUP_MAX_TABS = 60;

/**
 * Should a page's request for a new window become a new ForgeOS tab?
 *
 * Electron has no popup blocker, so the rule is stated here: only an http(s)
 * destination, only from the visible human tab, and only immediately after
 * real user input on that tab. Everything else is refused.
 */
function popupDecision({ url, agentOwned, closing, active, msSinceUserInput, openTabs } = {}) {
  if (agentOwned) return { open: false, reason: 'agent tabs never open tabs' };
  if (closing || !active) return { open: false, reason: 'not the visible tab' };
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { open: false, reason: 'unparseable destination' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return { open: false, reason: 'destination is not http(s)' };
  if (parsed.username || parsed.password) return { open: false, reason: 'destination carries credentials' };
  const elapsed = Number(msSinceUserInput);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > POPUP_INPUT_WINDOW_MS)
    return { open: false, reason: 'no recent user input' };
  if (!(Number(openTabs) < POPUP_MAX_TABS)) return { open: false, reason: 'too many open tabs' };
  return { open: true, url: parsed.href };
}

module.exports = { browserViewBounds, popupDecision, POPUP_INPUT_WINDOW_MS, POPUP_MAX_TABS };
