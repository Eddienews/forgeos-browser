/*
 * page-web-preferences.js — canonical WebContentsView security contract.
 *
 * The real browser and the Electron E2E harness must use this same factory so
 * tests cannot accidentally validate a safer configuration than production.
 */
'use strict';

function createPageWebPreferences({ partition = null } = {}) {
  return {
    partition: partition || undefined,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

module.exports = { createPageWebPreferences };
