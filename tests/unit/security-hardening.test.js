'use strict';

/* Gate K — trust-boundary hardening: permission checks, chrome-only IPC,
 * chrome UI session/CSP, download opening, and private data storage. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { permissionCheckAllowed, permissionGrantKey } = require('../../src/engine/fingerprint');
const { isSafeToOpen } = require('../../src/engine/download-center');
const { resolveDataDir, dataFile, writePrivateAtomic } = require('../../src/engine/settings');
const { childEnvironment } = require('../../src/ext/plugins');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function installedAdapter(modeId = 'standard', dialogAnswer = 0) {
  const originalLoad = Module._load;
  let SessionAdapter;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { dialog: { showMessageBoxSync: () => dialogAnswer } };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../../src/ext/electron-adapter')];
    ({ SessionAdapter } = require('../../src/ext/electron-adapter'));
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../../src/ext/electron-adapter')];
  }
  const handlers = {};
  const session = {
    webRequest: { onBeforeSendHeaders() {}, onBeforeRequest() {}, onHeadersReceived() {} },
    setPermissionRequestHandler(fn) { handlers.request = fn; },
    setPermissionCheckHandler(fn) { handlers.check = fn; },
    setDevicePermissionHandler(fn) { handlers.device = fn; },
    on() {},
  };
  const adapter = new SessionAdapter({ session, engine: {}, log: { log() {} }, modeId,
    getChromeWindow: () => ({ isDestroyed: () => false }) });
  adapter.install();
  return { adapter, handlers };
}

module.exports = [
  {
    name: 'permission checks deny ASK and unknown permissions until the user grants the origin',
    gate: 'K',
    fn(a) {
      const grants = new Set();
      for (const permission of ['geolocation', 'notifications', 'media', 'midi', 'clipboard-read'])
        a.strictEqual(permissionCheckAllowed(permission, 'standard', 'https://site.test', grants), false, permission);
      for (const permission of ['sensors', 'idle-detection', 'local-fonts', 'background-sync', 'made-up'])
        a.strictEqual(permissionCheckAllowed(permission, 'standard', 'https://site.test', grants), false, permission);
      a.strictEqual(permissionCheckAllowed('fullscreen', 'standard', 'https://site.test', grants), true);
      grants.add(permissionGrantKey('https://site.test/page?x=1', 'geolocation'));
      a.strictEqual(permissionCheckAllowed('geolocation', 'standard', 'https://site.test/', grants), true);
      a.strictEqual(permissionCheckAllowed('geolocation', 'standard', 'https://other.test', grants), false);
      a.strictEqual(permissionCheckAllowed('notifications', 'standard', 'https://site.test', grants), false);
      // Strict turns ASK into DENY: an earlier grant must not survive the mode.
      a.strictEqual(permissionCheckAllowed('geolocation', 'strict', 'https://site.test', grants), false);
    },
  },
  {
    name: 'opaque or malformed origins never hold a permission grant',
    gate: 'K',
    fn(a) {
      a.strictEqual(permissionGrantKey('null', 'geolocation'), null);
      a.strictEqual(permissionGrantKey('data:text/html,x', 'geolocation'), null);
      a.strictEqual(permissionGrantKey('', 'geolocation'), null);
      a.strictEqual(permissionCheckAllowed('geolocation', 'standard', '', new Set(['null geolocation'])), false);
    },
  },
  {
    name: 'session adapter installs check and device handlers that fail closed',
    gate: 'K',
    fn(a) {
      const { handlers } = installedAdapter('standard', 0);
      a.strictEqual(typeof handlers.check, 'function');
      a.strictEqual(typeof handlers.device, 'function');
      a.strictEqual(handlers.check(null, 'geolocation', 'https://site.test/', {}), false);
      a.strictEqual(handlers.check(null, 'notifications', '', { requestingUrl: 'https://site.test/a' }), false);
      a.strictEqual(handlers.check(null, 'clipboard-sanitized-write', 'https://site.test/', {}), true);
      a.strictEqual(handlers.device({ deviceType: 'usb', origin: 'https://site.test' }), false);
    },
  },
  {
    name: 'a dialog approval grants later checks for that origin only, and clearing forgets it',
    gate: 'K',
    fn(a) {
      const { adapter, handlers } = installedAdapter('standard', 1);
      let answer = null;
      handlers.request({ getURL: () => 'https://site.test/' }, 'notifications', (ok) => { answer = ok; },
        { requestingUrl: 'https://site.test/app' });
      a.strictEqual(answer, true);
      a.strictEqual(handlers.check(null, 'notifications', 'https://site.test', {}), true);
      a.strictEqual(handlers.check(null, 'notifications', 'https://evil.test', {}), false);
      a.strictEqual(handlers.check(null, 'geolocation', 'https://site.test', {}), false);
      adapter.clearPermissionGrants();
      a.strictEqual(handlers.check(null, 'notifications', 'https://site.test', {}), false);
    },
  },
  {
    name: 'a denied dialog leaves no grant behind',
    gate: 'K',
    fn(a) {
      const { handlers } = installedAdapter('standard', 0);
      let answer = null;
      handlers.request({ getURL: () => 'https://site.test/' }, 'geolocation', (ok) => { answer = ok; },
        { requestingUrl: 'https://site.test/' });
      a.strictEqual(answer, false);
      a.strictEqual(handlers.check(null, 'geolocation', 'https://site.test', {}), false);
    },
  },
  {
    name: 'every IPC channel is registered through the chrome-only sender check',
    gate: 'K',
    fn(a) {
      const main = read('src/main.js');
      a.strictEqual((main.match(/ipcMain\.handle\(/g) || []).length, 1, 'only the wrapper may call ipcMain.handle');
      a.match(main, /const handle = \(channel, listener\) => ipcMain\.handle\(channel, \(event, \.\.\.args\) => \{\s+if \(!trustedSender\(event\)\)/);
      a.match(main, /event\.sender === w\.webContents && event\.senderFrame === w\.webContents\.mainFrame/);
      a.ok((main.match(/\n  handle\('forge:/g) || []).length > 50);
      a.doesNotMatch(main, /ipcMain\.(on|handleOnce)\(/);
    },
  },
  {
    name: 'chrome UI windows use their own session and a CSP without inline script',
    gate: 'K',
    fn(a) {
      const main = read('src/main.js');
      a.strictEqual((main.match(/partition: CHROME_UI_PARTITION,/g) || []).length, 2);
      a.match(main, /"script-src 'self'",/);
      a.doesNotMatch(main, /script-src[^"\n]*unsafe-inline/);
      for (const file of ['src/renderer/index.html', 'src/renderer/panels.html']) {
        const html = read(file);
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html);
        a.ok(csp, file);
        a.match(csp[1], /script-src 'self'(;|$)/, file);
        a.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${file} inline script`);
        a.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/, `${file} inline handler`);
      }
    },
  },
  {
    name: 'only inert document and media downloads may be opened',
    gate: 'K',
    fn(a) {
      for (const name of ['notes.txt', 'paper.PDF', 'clip.mp4', 'photo.jpeg', 'captions.vtt', '/d/browser-x/song.flac'])
        a.strictEqual(isSafeToOpen(name), true, name);
      for (const name of ['run.desktop', 'tool.AppImage', 'pkg.deb', 'link.lnk', 'app.hta', 'x.js', 'page.html',
        'a.svg', 'site.url', 'doc.docm', 'archive.zip', 'script.sh', 'setup.exe', 'noextension', '.txt',
        'trick.txt.', 'trick.txt ', 'report.pdf.exe', '', null])
        a.strictEqual(isSafeToOpen(name), false, String(name));
      const main = read('src/main.js');
      a.match(main, /record\.executable \|\| !isSafeToOpen\(record\.path\)/);
    },
  },
  {
    name: 'packaged data lives in user data, portable data next to the executable',
    gate: 'K',
    fn(a) {
      const exe = path.join('/opt', 'forge', 'forge-browser-lab');
      const none = { existsSync: () => false };
      const portable = { existsSync: (p) => p === path.join('/opt', 'forge', '.portable') };
      a.strictEqual(resolveDataDir({ packaged: true, execPath: exe, fileSystem: none, userData: () => '/home/u/.config/Forge' }),
        '/home/u/.config/Forge');
      a.strictEqual(resolveDataDir({ packaged: true, execPath: exe, fileSystem: portable, userData: () => '/home/u/.config/Forge' }),
        path.join('/opt', 'forge'));
      a.strictEqual(resolveDataDir({ packaged: true, execPath: exe, fileSystem: none, userData: () => { throw new Error('x'); } }),
        path.join('/opt', 'forge'));
      a.strictEqual(resolveDataDir({ packaged: false }), root);
    },
  },
  {
    name: 'legacy data next to the executable moves once into the private data directory',
    gate: 'K',
    fn(a) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-data-'));
      try {
        const exeDir = path.join(tmp, 'install');
        const dataDir = path.join(tmp, 'userdata');
        fs.mkdirSync(exeDir);
        fs.writeFileSync(path.join(exeDir, 'forge-history.json'), '[{"url":"https://old.test/"}]', { mode: 0o644 });
        const options = { packaged: true, execPath: path.join(exeDir, 'forge'), userData: () => dataDir };
        const file = dataFile('forge-history.json', options);
        a.strictEqual(file, path.join(dataDir, 'forge-history.json'));
        a.strictEqual(fs.readFileSync(file, 'utf8'), '[{"url":"https://old.test/"}]');
        a.strictEqual(fs.existsSync(path.join(exeDir, 'forge-history.json')), false);
        if (process.platform !== 'win32') a.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        // A newer file in the data directory is never overwritten by a stray legacy copy.
        fs.writeFileSync(path.join(exeDir, 'forge-history.json'), '[]');
        a.strictEqual(dataFile('forge-history.json', options), file);
        a.strictEqual(fs.readFileSync(file, 'utf8'), '[{"url":"https://old.test/"}]');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'external download tools never inherit the inference key',
    gate: 'K',
    fn(a) {
      const env = childEnvironment({ ytdlp: path.join('/opt', 'tools', 'yt-dlp') },
        { PATH: '/usr/bin', HOME: '/home/u', FORGE_TYPESAFE_API_KEY: 'sk-secret-value-123' });
      a.strictEqual('FORGE_TYPESAFE_API_KEY' in env, false);
      a.strictEqual(env.HOME, '/home/u');
      a.strictEqual(env.PATH, [path.join('/opt', 'tools'), '/usr/bin'].join(path.delimiter));
      a.doesNotMatch(JSON.stringify(env), /sk-secret-value-123/);
    },
  },
  {
    name: 'packaged binaries disable Node runtime, NODE_OPTIONS and inspector fuses',
    gate: 'K',
    fn(a) {
      const { FuseV1Options, FuseVersion } = require('@electron/fuses');
      const { fuseConfig, packagedExecutable } = require('../../scripts/package');
      for (const [plat, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
        const config = fuseConfig(plat, arch);
        a.strictEqual(config.version, FuseVersion.V1);
        a.strictEqual(config[FuseV1Options.RunAsNode], false);
        a.strictEqual(config[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
        a.strictEqual(config[FuseV1Options.EnableNodeCliInspectArguments], false);
        a.strictEqual(config[FuseV1Options.OnlyLoadAppFromAsar], true);
        a.strictEqual(config.resetAdHocDarwinSignature, plat === 'darwin' && arch === 'arm64');
      }
      a.strictEqual(packagedExecutable('out', 'win32'), path.join('out', 'ForgeBrowserLab.exe'));
      a.strictEqual(packagedExecutable('out', 'linux'), path.join('out', 'ForgeBrowserLab'));
      a.strictEqual(packagedExecutable('out', 'darwin'), path.join('out', 'ForgeBrowserLab.app'));
    },
  },
  {
    name: 'ad hoc signature files are admitted only for re-signed Apple Silicon bundles',
    gate: 'K',
    fn(a) {
      const { approvedMacMember } = require('../../scripts/package-policy');
      const app = 'ForgeBrowserLab.app/Contents/';
      const helper = app + 'Frameworks/ForgeBrowserLab Helper (Renderer).app/Contents/';
      for (const base of [app, helper]) {
        a.strictEqual(approvedMacMember(base + '_CodeSignature', true, 'arm64'), true, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature/CodeResources', false, 'arm64'), true, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature', true, 'x64'), false, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature/CodeResources', false, 'x64'), false, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature', false, 'arm64'), false, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature/CodeResources', true, 'arm64'), false, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature/extra.bin', false, 'arm64'), false, base);
        a.strictEqual(approvedMacMember(base + '_CodeSignature/CodeResources/x', false, 'arm64'), false, base);
      }
    },
  },
  {
    name: 'private writes are owner-only even over an existing readable file',
    gate: 'K',
    fn(a) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-private-'));
      try {
        const file = path.join(tmp, 'nested', 'forge-settings.json');
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, 'old', { mode: 0o644 });
        fs.writeFileSync(file + '.tmp', 'stale', { mode: 0o644 });
        writePrivateAtomic(file, 'new');
        a.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
        a.strictEqual(fs.existsSync(file + '.tmp'), false);
        if (process.platform !== 'win32') a.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
];
