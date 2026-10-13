'use strict';

/* Gate J — the main process is composed from small modules under src/main/. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const MODULES = ['agent-actions', 'downloads', 'page-injection', 'page-output', 'smoke', 'update-notice'];

module.exports = [
  {
    name: 'every main-process module is packaged and wired through the shared context',
    gate: 'J',
    fn(a) {
      const { PACKAGE_FILES } = require('../../scripts/package-policy');
      const present = fs.readdirSync(path.join(root, 'src/main')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
      a.deepStrictEqual(present, [...MODULES].sort(), 'a new module must be listed here and in the package policy');
      const main = read('src/main.js');
      for (const name of MODULES) {
        a.ok(PACKAGE_FILES.includes(`src/main/${name}.js`), name);
        a.match(main, new RegExp(`require\\('\\./main/${name}'\\)`), name);
        // Modules take what they need from ctx; they never reach back into main.js.
        a.doesNotMatch(read(`src/main/${name}.js`), /require\('\.\.\/main'\)|require\('\.\.\/main\.js'\)/, name);
      }
    },
  },
  {
    name: 'modules log through a logger that follows the real event log',
    gate: 'J',
    fn(a) {
      const main = read('src/main.js');
      // `log` is a no-op until the app is ready and is then replaced. A module
      // handed that first object would log nowhere for the whole session.
      a.match(main, /const logger = \{ log: \(\.\.\.args\) => log\.log\(\.\.\.args\) \};/);
      a.doesNotMatch(main, /new PluginRunner\(/, 'the plugin runner is built in src/main/downloads.js');
      for (const name of MODULES) a.match(read(`src/main/${name}.js`), /const log = ctx\.logger;/, name);
    },
  },
  {
    name: 'the download registry reports only what is safe to open, and plugin jobs use the live logger',
    gate: 'J',
    fn(a) {
      const { createDownloads } = require('../../src/main/downloads');
      const sent = [];
      const lines = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dl-'));
      try {
        const logger = { log: (...args) => lines.push(args) };
        const api = createDownloads({ logger, chromeWin: null, getDownloadDir: () => dir,
          sendToChrome: (channel, payload) => sent.push([channel, payload]) });
        a.strictEqual(api.plugins.log, logger);
        const doc = api.pushDownload({ id: 'a', filename: 'notes.pdf', state: 'completed' });
        const tool = api.pushDownload({ id: 'b', filename: 'tool.AppImage', state: 'completed' });
        a.strictEqual(doc.openable, true);
        a.strictEqual(tool.openable, false);
        a.deepStrictEqual(sent.map(([channel]) => channel), ['forge:download', 'forge:download']);
        a.strictEqual(api.downloads.length, 2);
        a.strictEqual(api.downloads[0].id, 'b', 'most recent first');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'agent actions refuse without an agent tab or a window, through the real module wiring',
    gate: 'J',
    async fn(a) {
      const { createAgentActions } = require('../../src/main/agent-actions');
      const logs = [];
      const wc = { isDestroyed: () => false, getURL: () => 'https://site.test/', executeJavaScript: async () => { throw new Error('must not run'); } };
      const tab = { wc, agentOwned: true };
      let window = null;
      let agentReady = false;
      const api = createAgentActions({
        logger: { log: (...entry) => logs.push(entry) },
        activeTab: () => tab,
        requireAgentTab: async () => { if (!agentReady) throw new Error('no agent tab'); return tab; },
        get chromeWin() { return window; },
      });
      // Observation and action both stop at the agent-tab guard before touching the page.
      a.deepStrictEqual(await api.readIndexedSnapshot(), { error: 'no agent tab' });
      const refusedAct = await api.executeAgentAction({ kind: 'click', targetIndex: 1 });
      a.strictEqual(refusedAct.ok, false);
      a.match(refusedAct.reason, /no agent tab/);
      // No window means no human to ask: approval is refused and logged.
      agentReady = true;
      a.strictEqual(await api.approveAgentAction({ action: { kind: 'click', targetIndex: 1 } }), false);
      a.ok(logs.some((entry) => entry[0] === 'DENY' && /approval unavailable/.test(entry[1])));
      // The window is read live: a destroyed one is refused the same way.
      window = { isDestroyed: () => true };
      a.strictEqual(await api.approveAgentAction({ action: { kind: 'click', targetIndex: 1 } }), false);
      // With a window but no browser-held observation, an agent-owned proposal is rejected before any dialog.
      window = { isDestroyed: () => false };
      a.strictEqual(await api.approveAgentAction({ action: { kind: 'click', targetIndex: 1, fingerprint: 'x' } }), false);
      a.ok(logs.some((entry) => /preview invalidated/.test(entry[1])));
    },
  },
  {
    name: 'startup never takes the view from a tab that is already showing',
    gate: 'J',
    fn(a) {
      const main = read('src/main.js');
      const start = main.indexOf('const saved = sessionStore.restoreTabRecords(getRuntimeBase())');
      const body = main.slice(start, main.indexOf('// Links given on the command line', start));
      a.ok(start > 0 && body.length > 100);
      // An agent can open its tab before startup finishes; the restored or
      // blank tab must not replace it as the visible tab.
      a.match(body, /if \(activeTabId == null\) switchTab\(t\.id, \{ focus: false \}\);/);
      a.match(body, /\} else if \(!tabs\.size\) \{\s+const t = createTab\('about:blank'\);/);
      a.strictEqual((body.match(/switchTab\(/g) || []).length, 2);
    },
  },
  {
    name: 'switching tabs hides the previous view and never detaches it',
    gate: 'J',
    fn(a) {
      const main = read('src/main.js');
      const start = main.indexOf('function switchTab(');
      const body = main.slice(start, main.indexOf('async function closeTab(', start));
      a.ok(start > 0 && body.length > 100);
      // A detached view does not draw again when it is attached again: the tab
      // came back empty until the browser was restarted.
      a.doesNotMatch(body, /removeChildView/);
      a.match(body, /if \(prev && prev !== tab\) prev\.view\.setVisible\(false\);/);
      a.match(body, /chromeWin\.contentView\.addChildView\(tab\.view\);/);
      a.strictEqual((main.match(/removeChildView\(/g) || []).length, 1, 'only closing a tab detaches its view');
    },
  },
  {
    name: 'with no window to ask, a plugin job is never approved',
    gate: 'J',
    async fn(a) {
      const { createDownloads } = require('../../src/main/downloads');
      const api = createDownloads({ logger: { log() {} }, chromeWin: null, getDownloadDir: () => os.tmpdir(), sendToChrome() {} });
      const result = await api.runPluginJob('video', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'clip');
      a.strictEqual(result.state, 'denied');
      const refused = await api.runPluginJob('video', 'https://example.com/not-youtube', 'x');
      a.strictEqual(refused.state, 'error');
    },
  },
];
