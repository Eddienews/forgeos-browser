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
    name: 'user agent and client-hint platform name the real operating system consistently',
    gate: 'K',
    fn(a) {
      const { GENERIC_UA, genericUserAgent, clientHintPlatform, applyAppLevelHardening } =
        require('../../src/engine/fingerprint-hardening');
      const expected = { win32: ['Windows NT 10.0; Win64; x64', '"Windows"'],
        darwin: ['Macintosh; Intel Mac OS X 10_15_7', '"macOS"'], linux: ['X11; Linux x86_64', '"Linux"'] };
      for (const [platform, [token, hint]] of Object.entries(expected)) {
        const ua = genericUserAgent(platform, '150.0.1.2');
        a.strictEqual(ua, `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1.2 Safari/537.36`);
        a.strictEqual(clientHintPlatform(platform), hint);
        a.doesNotMatch(ua, /Electron|Forge/i);
      }
      a.strictEqual(GENERIC_UA, genericUserAgent(process.platform));
      a.strictEqual(clientHintPlatform('freebsd'), '"Linux"');
      // No command-line switch is appended after startup, where it has no effect.
      const app = { commandLine: { appendSwitch() { throw new Error('unexpected switch'); } } };
      applyAppLevelHardening(app);
      a.strictEqual(app.userAgentFallback, GENERIC_UA);
      const adapter = read('src/ext/electron-adapter.js');
      a.doesNotMatch(adapter, /'"Windows"'/);
      a.strictEqual((adapter.match(/= uaPlatform;/g) || []).length, 2);
    },
  },
  {
    name: 'every GitHub Action is pinned to a full commit SHA',
    gate: 'K',
    fn(a) {
      const directory = path.join(root, '.github/workflows');
      const files = fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
      a.ok(files.includes('build.yml') && files.includes('nightly.yml'));
      for (const name of files) {
        const workflow = fs.readFileSync(path.join(directory, name), 'utf8');
        a.ok((workflow.match(/uses:\s+\S+@[0-9a-f]{40} # v\d+/g) || []).length >= 2, name);
        a.doesNotMatch(workflow, /uses:\s+\S+@(?![0-9a-f]{40}\b)/, name);
      }
    },
  },
  {
    name: 'the Electron freshness check flags a stale line and an unsupported major',
    gate: 'K',
    fn(a) {
      const { assessElectron } = require('../../scripts/check-electron');
      const released = ['41.9.0', '42.3.1', '43.5.1', '43.7.9', '44.0.0', '44.7.0', '45.0.0-beta.2', '46.0.0-nightly.20261001'];
      const current = assessElectron('43.7.9', released);
      a.strictEqual(current.ok, true);
      a.strictEqual(current.newestInLine, '43.7.9');
      a.strictEqual(current.newestStable, '44.7.0', 'pre-releases are ignored');
      const stale = assessElectron('43.5.1', released);
      a.strictEqual(stale.ok, false);
      a.match(stale.problems[0], /behind 43\.7\.9/);
      const numeric = assessElectron('43.7.9', ['43.7.9', '43.7.10']);
      a.strictEqual(numeric.ok, false, 'versions compare numerically, not as text');
      const unsupported = assessElectron('41.9.0', released);
      a.strictEqual(unsupported.ok, false);
      a.match(unsupported.problems.join(' '), /no longer supported/);
      a.strictEqual(assessElectron('42.3.1', released).ok, true, 'third-newest major is still supported');
      a.strictEqual(assessElectron('^43.7.9', released).ok, false, 'a range is not a pin');
      a.strictEqual(assessElectron('43.7.9', []).ok, false);
      // Scheduled, read-only, and wired to the same check.
      const nightly = read('.github/workflows/nightly.yml');
      a.match(nightly, /schedule:\s+- cron: '\d+ \d+ \* \* \*'/);
      a.match(nightly, /permissions:\s+contents: read\n/);
      a.match(nightly, /run: npm run check:electron/);
      a.match(nightly, /run: npm audit --audit-level=high/);
      a.match(read('.github/dependabot.yml'), /package-ecosystem: npm[\s\S]+interval: daily/);
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
