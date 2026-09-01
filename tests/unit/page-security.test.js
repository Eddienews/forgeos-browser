/* Gate K — the production page-view security contract. */
'use strict';

const { createPageWebPreferences } = require('../../src/page-web-preferences');

module.exports = [
  {
    name: 'page views are sandboxed, isolated, and have Node disabled',
    gate: 'K',
    fn(a) {
      const prefs = createPageWebPreferences({ partition: 'test' });
      a.strictEqual(prefs.sandbox, true);
      a.strictEqual(prefs.contextIsolation, true);
      a.strictEqual(prefs.nodeIntegration, false);
    },
  },
  {
    name: 'page views have no preload or privileged integration surface',
    gate: 'K',
    fn(a) {
      const prefs = createPageWebPreferences({});
      a.ok(!Object.prototype.hasOwnProperty.call(prefs, 'preload'));
      a.ok(!Object.prototype.hasOwnProperty.call(prefs, 'enableRemoteModule'));
    },
  },
];
