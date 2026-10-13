'use strict';

/* Gate K — remembered per-site permission decisions never widen the policy. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { createStore, siteOrigin, isManaged, MANAGED_PERMISSIONS } = require('../../src/engine/site-permissions');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-perms-'));
  const file = path.join(dir, 'forge-permissions.json');
  return { dir, file, store: createStore({ file }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A real SessionAdapter over a fake session, with a scripted dialog answer. */
function adapterWith({ modeId = 'standard', answer = 0, sitePermissions = null } = {}) {
  const originalLoad = Module._load;
  const dialogs = [];
  let SessionAdapter;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { dialog: { showMessageBoxSync: (_w, options) => { dialogs.push(options); return answer; } } };
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
    setDevicePermissionHandler() {},
    on() {},
  };
  const adapter = new SessionAdapter({ session, engine: {}, log: { log() {} }, modeId, sitePermissions,
    getChromeWindow: () => ({ isDestroyed: () => false }) });
  adapter.install();
  const request = (permission, details) => {
    let result = null;
    handlers.request({ getURL: () => 'https://site.test/' }, permission, (ok) => { result = ok; }, details);
    return result;
  };
  return { adapter, handlers, dialogs, request };
}

const MAIN = { requestingUrl: 'https://site.test/app', isMainFrame: true };

module.exports = [
  {
    name: 'only exact http(s) origins and managed permissions can be remembered',
    gate: 'K',
    fn(a) {
      a.strictEqual(siteOrigin('https://site.test/a?b#c'), 'https://site.test');
      a.strictEqual(siteOrigin('http://localhost:8080/'), 'http://localhost:8080');
      for (const bad of ['file:///etc/passwd', 'data:text/html,x', 'about:blank', 'null', '', null, 'https://u:p@site.test/',
        'https://site.test/\n'])
        a.strictEqual(siteOrigin(bad), null, String(bad));
      a.deepStrictEqual(Object.keys(MANAGED_PERMISSIONS), ['media', 'geolocation', 'notifications', 'clipboard-read']);
      for (const name of ['usb', 'hid', 'serial', 'midi', 'toString', '__proto__', 'constructor', ''])
        a.strictEqual(isManaged(name), false, name);
    },
  },
  {
    name: 'a decision is stored owner-only, survives a reload, and resets to ask',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        a.strictEqual(t.store.get('https://site.test', 'media'), null);
        a.deepStrictEqual(t.store.set('https://site.test/page', 'media', 'allow'),
          { ok: true, origin: 'https://site.test', permission: 'media', state: 'allow' });
        a.strictEqual(t.store.set('https://site.test', 'geolocation', 'deny').ok, true);
        if (process.platform !== 'win32') a.strictEqual(fs.statSync(t.file).mode & 0o777, 0o600);
        const fresh = createStore({ file: t.file });
        a.strictEqual(fresh.get('https://site.test/other', 'media'), 'allow');
        a.strictEqual(fresh.get('https://site.test', 'geolocation'), 'deny');
        a.strictEqual(fresh.get('https://other.test', 'media'), null);
        a.strictEqual(fresh.get('http://site.test', 'media'), null, 'scheme is part of the origin');
        a.deepStrictEqual(fresh.list('https://site.test').map((p) => p.state), ['allow', 'deny', 'ask', 'ask']);
        a.strictEqual(fresh.set('https://site.test', 'media', 'ask').ok, true);
        a.strictEqual(fresh.set('https://site.test', 'geolocation', 'ask').ok, true);
        a.strictEqual(fs.readFileSync(t.file, 'utf8').trim(), '{}');
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'invalid input is refused and a failed write leaves no decision in memory',
    gate: 'K',
    fn(a) {
      const store = createStore({ file: '/nonexistent/forge-permissions.json',
        fileSystem: { readFileSync() { throw new Error('ENOENT'); } },
        write() { throw new Error('EIO fixture'); } });
      a.strictEqual(store.set('file:///x', 'media', 'allow').ok, false);
      a.strictEqual(store.set('https://site.test', 'usb', 'allow').ok, false);
      a.strictEqual(store.set('https://site.test', 'media', 'granted').ok, false);
      const failed = store.set('https://site.test', 'media', 'allow');
      a.strictEqual(failed.ok, false);
      a.match(failed.reason, /Unable to save site permission/);
      a.strictEqual(store.get('https://site.test', 'media'), null);
    },
  },
  {
    name: 'a damaged or hand-edited file can never grant more than the managed set',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        fs.writeFileSync(t.file, JSON.stringify({
          'https://site.test': { media: 'allow', usb: 'allow', geolocation: 'yes', notifications: 'deny' },
          'https://site.test/path': { media: 'allow' },
          'file:///etc': { media: 'allow' },
          'https://array.test': ['allow'],
          'https://empty.test': {},
        }));
        const store = createStore({ file: t.file });
        a.deepStrictEqual(store.list('https://site.test').map((p) => p.state), ['allow', 'ask', 'deny', 'ask']);
        a.strictEqual(store.get('https://site.test/path', 'media'), 'allow', 'lookups normalize to the stored origin');
        a.strictEqual(store.get('https://array.test', 'media'), null);
        fs.writeFileSync(t.file, '{not json');
        a.strictEqual(createStore({ file: t.file }).get('https://site.test', 'media'), null);
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'a remembered allow or deny answers the request without a dialog',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        t.store.set('https://site.test', 'media', 'allow');
        t.store.set('https://site.test', 'geolocation', 'deny');
        const { request, dialogs, handlers } = adapterWith({ sitePermissions: { ...t.store, isManaged, siteOrigin } });
        a.strictEqual(request('media', MAIN), true);
        a.strictEqual(request('geolocation', MAIN), false);
        a.strictEqual(dialogs.length, 0);
        a.strictEqual(handlers.check(null, 'media', 'https://site.test', { isMainFrame: true }), true);
        a.strictEqual(handlers.check(null, 'geolocation', 'https://site.test', { isMainFrame: true }), false);
        a.strictEqual(handlers.check(null, 'media', 'https://other.test', { isMainFrame: true }), false);
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'an embedded frame never inherits or records a remembered decision',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        t.store.set('https://site.test', 'media', 'allow');
        const sitePermissions = { ...t.store, isManaged, siteOrigin };
        const framed = { requestingUrl: 'https://site.test/embed', isMainFrame: false };
        const first = adapterWith({ answer: 0, sitePermissions });
        a.strictEqual(first.request('media', framed), false);
        a.strictEqual(first.dialogs.length, 1);
        a.deepStrictEqual(first.dialogs[0].buttons, ['Deny', 'Allow']);
        a.strictEqual(first.handlers.check(null, 'media', 'https://site.test', { isMainFrame: false }), false);
        a.strictEqual(first.handlers.check(null, 'media', 'https://site.test', undefined), false);
        // Even choosing a button index that means "always" in the main frame stores nothing here.
        const second = adapterWith({ answer: 3, sitePermissions });
        second.request('notifications', { requestingUrl: 'https://site.test/embed', isMainFrame: false });
        a.strictEqual(t.store.get('https://site.test', 'notifications'), null);
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'the dialog can remember always-allow and never-allow for the top-level site',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        const sitePermissions = { ...t.store, isManaged, siteOrigin };
        const session = adapterWith({ answer: 1, sitePermissions });
        a.strictEqual(session.request('notifications', MAIN), true);
        a.deepStrictEqual(session.dialogs[0].buttons,
          ['Deny', 'Allow this session', 'Always allow on this site', 'Never allow on this site']);
        a.strictEqual(session.dialogs[0].defaultId, 0);
        a.strictEqual(session.dialogs[0].cancelId, 0);
        a.strictEqual(t.store.get('https://site.test', 'notifications'), null, 'session-only choice is not stored');

        const always = adapterWith({ answer: 2, sitePermissions });
        a.strictEqual(always.request('notifications', MAIN), true);
        a.strictEqual(t.store.get('https://site.test', 'notifications'), 'allow');

        const never = adapterWith({ answer: 3, sitePermissions });
        a.strictEqual(never.request('geolocation', MAIN), false);
        a.strictEqual(t.store.get('https://site.test', 'geolocation'), 'deny');
        a.strictEqual(never.handlers.check(null, 'geolocation', 'https://site.test', { isMainFrame: true }), false);
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'remembered allows never override Strict mode, policy denials, or unmanaged permissions',
    gate: 'K',
    fn(a) {
      const t = tempStore();
      try {
        t.store.set('https://site.test', 'media', 'allow');
        const sitePermissions = { ...t.store, isManaged, siteOrigin };
        const strict = adapterWith({ modeId: 'strict', answer: 2, sitePermissions });
        a.strictEqual(strict.request('media', MAIN), false);
        a.strictEqual(strict.dialogs.length, 0);
        a.strictEqual(strict.handlers.check(null, 'media', 'https://site.test', { isMainFrame: true }), false);

        const standard = adapterWith({ answer: 2, sitePermissions });
        a.strictEqual(standard.request('made-up-permission', MAIN), false);
        a.strictEqual(standard.dialogs.length, 0);
        // midi is askable but not manageable: no remember buttons, nothing stored.
        a.strictEqual(standard.request('midi', MAIN), false);
        a.deepStrictEqual(standard.dialogs[0].buttons, ['Deny', 'Allow']);
        a.strictEqual(fs.readFileSync(t.file, 'utf8').includes('midi'), false);
      } finally { t.cleanup(); }
    },
  },
  {
    name: 'agent-owned sessions neither read nor record the human\'s site permissions',
    gate: 'K',
    fn(a) {
      const agent = adapterWith({ answer: 1, sitePermissions: null });
      a.strictEqual(agent.request('media', MAIN), true);
      a.deepStrictEqual(agent.dialogs[0].buttons, ['Deny', 'Allow']);
      const main = read('src/main.js');
      a.match(main, /function sitePermissionsFor\(partitionKey\) \{\s+return String\(partitionKey \|\| ''\)\.startsWith\('forge-agent-'\) \? null : sitePermissions;/);
      a.strictEqual((main.match(/sitePermissions: sitePermissionsFor\(partitionKey\)/g) || []).length, 2);
    },
  },
  {
    name: 'resetting or blocking a site withdraws an approval given earlier in the session',
    gate: 'K',
    fn(a) {
      const { adapter, request, handlers } = adapterWith({ answer: 1 });
      a.strictEqual(request('notifications', MAIN), true);
      a.strictEqual(handlers.check(null, 'notifications', 'https://site.test', {}), true);
      a.strictEqual(adapter.revokePermissionGrant('https://site.test/x', 'notifications'), true);
      a.strictEqual(handlers.check(null, 'notifications', 'https://site.test', {}), false);
      a.match(read('src/main.js'), /if \(state !== 'allow'\) tab\.adapter\.revokePermissionGrant\(status\.origin, permission\);/);
    },
  },
  {
    name: 'the site permission channel is human-site bound and confirms an always-allow natively',
    gate: 'K',
    fn(a) {
      const main = read('src/main.js');
      const start = main.indexOf("handle('forge:site-permission'");
      const body = main.slice(start, main.indexOf("handle('forge:site-clear'", start));
      a.ok(start > 0 && body.length > 200);
      a.match(body, /const tab = humanSite\(event\), status = siteStatus\(event\);/);
      a.match(body, /!sitePermissions\.isManaged\(permission\) \|\| !\['ask', 'allow', 'deny'\]\.includes\(state\)/);
      a.match(body, /if \(state === 'allow'\) \{[\s\S]+dialog\.showMessageBox\(chromeWin,[\s\S]+if \(response\.response !== 1\) return \{ ok: false/);
      a.match(body, /if \(humanSite\(event\) !== tab \|\| siteStatus\(event\)\?\.origin !== status\.origin\)/);
      // The renderer never names the origin: it comes from the live tab.
      a.match(body, /sitePermissions\.set\(status\.origin, permission, state\)/);
      a.match(read('src/preload.js'), /sitePermission: \(permission, state\) => ipcRenderer\.invoke\('forge:site-permission', permission, state\)/);
      const html = read('src/renderer/index.html');
      for (const permission of Object.keys(MANAGED_PERMISSIONS))
        a.match(html, new RegExp(`<select id="site-perm-${permission}" data-permission="${permission}">`));
      const { PACKAGE_FILES } = require('../../scripts/package-policy');
      a.ok(PACKAGE_FILES.includes('src/engine/site-permissions.js'));
    },
  },
];
