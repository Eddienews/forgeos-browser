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
    // Electron otherwise defaults to allowing autoplay without a gesture.
    // Requiring document activation keeps restored media tabs silent until
    // the user deliberately interacts with the page.
    autoplayPolicy: 'document-user-activation-required',
  };
}

module.exports = { createPageWebPreferences };
