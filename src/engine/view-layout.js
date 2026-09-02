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

module.exports = { browserViewBounds };
