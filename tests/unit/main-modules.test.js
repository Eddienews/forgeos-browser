'use strict';

/* Gate J — the main process is composed from small modules under src/main/. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const MODULES = ['downloads', 'page-injection', 'page-output', 'smoke', 'update-notice'];

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
