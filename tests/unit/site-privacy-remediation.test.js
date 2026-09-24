'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

function adapterFixture() {
  const original = Module._load;
  let SessionAdapter;
  try {
    Module._load = function (name, parent, main) {
      if (name === 'electron') return { dialog: {}, webContents: { fromId: id => contents.get(id) || null } };
      if (name === '../engine/site-allowlist' && parent.filename.endsWith('electron-adapter.js'))
        return { isAllowed: host => host === 'allowed.test' };
      return original.call(this, name, parent, main);
    };
    delete require.cache[require.resolve('../../src/ext/electron-adapter')];
    ({ SessionAdapter } = require('../../src/ext/electron-adapter'));
  } finally { Module._load = original; }
  const contents = new Map();
  const handlers = {};
  const ses = { webRequest: {
    onBeforeSendHeaders() {}, onBeforeRequest(_filter, fn) { handlers.before = fn; },
    onHeadersReceived(_filter, fn) { handlers.headers = fn; },
  }, setPermissionRequestHandler() {}, on() {} };
  const engine = { classifyRequest({ url }) { return { category: 'ADVERTISING', filterDecision: 'block', matchedKind: 'hostname', matchedRule: 'fixture', firstParty: false }; } };
  const adapter = new SessionAdapter({ session: ses, engine, log: { log() {} }, modeId: 'standard' });
  adapter.install();
  function request(url, resourceType, referrer, webContentsId = 7) {
    let response;
    handlers.before({ url, resourceType, referrer, webContentsId }, r => { response = r; });
    return response;
  }
  return { contents, request, handlers, ses };
}

function allowlistFixture(files = new Map()) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/engine/site-allowlist.js'), 'utf8');
  const calls = [];
  let fail = '';
  const fakeFs = {
    readFileSync(p) { if (!files.has(p)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } return files.get(p); },
    writeFileSync(p, value) { calls.push(['write', p]); if (p.endsWith(fail) && fail) throw new Error('EIO fixture write'); files.set(p, value); },
    renameSync(from, to) { calls.push(['rename', to]); if (to.endsWith(fail) && fail) throw new Error('EIO fixture rename'); files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(p) { files.delete(p); },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: name => name === 'fs' ? fakeFs : require(name), module,
    __dirname: path.join(__dirname, '../../src/engine'), process }, { filename: 'site-allowlist.js' });
  return { api: module.exports, files, calls, setFailure: x => { fail = x; } };
}

function uiFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/ui.js'), 'utf8');
  const start = source.indexOf('  /* ---------------- site menu (badge click)');
  const end = source.indexOf('  /* Trust presets:', start);
  const stateStart = source.indexOf('  let applyState = function (s)');
  const stateEnd = source.indexOf('  F.onState(applyState);', stateStart);
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, { id, textContent: '', checked: false, disabled: false, dataset: {}, style: {}, events: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
          toggle: (x, force) => { if (force) classes.add(x); else classes.delete(x); } },
        addEventListener(type, fn) { this.events[type] = fn; }, getBoundingClientRect: () => ({ left: 200 }) });
    }
    return elements.get(id);
  }
  const pending = [];
  const F = { sitePrivacy: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    setMenuOpen() {}, siteException: async () => ({ ok: true }), siteClear: async () => ({ ok: true }) };
  const context = { F, $, URL, document: { querySelector: () => el('sec-badge'), getElementById: el, activeElement: null,
      querySelectorAll: () => [] }, reserveSpaceFor() {}, refreshBadge() {}, renderTabs() {}, renderCounters() {},
    renderAuditHealth() {}, MODE_HINTS: {}, state: null, setTimeout: () => {}, closeMenu() {} };
  function $(id) { return el(id); }
  vm.runInNewContext(source.slice(start, end) + '\n' + source.slice(stateStart, stateEnd) +
    '\nthis.open = openSiteMenu; this.apply = applyState; this.close = closeSiteMenu;', context);
  const update = (id, url) => context.apply({ activeTabId: id, tabs: [{ id, url, security: { label: 'HTTPS', ok: true } }], mode: 'standard' });
  return { context, el, pending, update };
}

module.exports = [
  { name: 'navigation uses destination host, never an allowlisted referrer', fn: a => {
    const f = adapterFixture();
    a.strictEqual(f.request('https://ads.example.test/', 'mainFrame', 'https://allowed.test/', 7).cancel, true);
  } },
  { name: 'referrerless subrequest uses owning page, not request host or foreign contents', fn: a => {
    const f = adapterFixture();
    f.contents.set(7, { session: f.ses, isDestroyed: () => false, getURL: () => 'https://allowed.test/page' });
    a.deepStrictEqual(f.request('https://ads.example.test/banner.js', 'script', '', 7), {});
    a.deepStrictEqual(f.request('https://ads.example.test/banner.js', 'script', 'https://allowed.test/', 99), { redirectURL: 'data:application/javascript,' });
  } },
  { name: 'allowlist write failure rolls back cache and reports failure', fn: a => {
    const f = allowlistFixture(); f.setFailure('forge-allowlist.json');
    const r = f.api.addExact('new.test');
    a.strictEqual(r.ok, false);
    a.strictEqual(f.api.isAllowed('new.test'), false);
    a.strictEqual(f.files.has(f.api.FILE), false);
  } },
  { name: 'preset metadata write failure cannot leave an in-memory grant', fn: a => {
    const f = allowlistFixture(); f.setFailure('.presets');
    const r = f.api.applyPreset('google');
    a.strictEqual(r.ok, false);
    a.strictEqual(f.api.isAllowed('google.com'), false);
    a.strictEqual(f.api.activePresets().google, undefined);
  } },
  { name: 'failed host-list rename restores prior preset metadata and revoked grant', fn: a => {
    const f = allowlistFixture();
    a.strictEqual(f.api.applyPreset('apple').ok, true);
    const before = new Map(f.files);
    f.setFailure('forge-allowlist.json');
    const result = f.api.revokePreset('apple');
    a.strictEqual(result.ok, false);
    a.match(result.reason, /Unable to save site exception/);
    a.strictEqual(f.api.isAllowed('apple.com'), true);
    a.strictEqual(f.api.activePresets().apple, 3);
    a.deepStrictEqual(f.files.get(f.api.FILE), before.get(f.api.FILE));
    a.deepStrictEqual(f.files.get(f.api.FILE + '.presets'), before.get(f.api.FILE + '.presets'));
    const restarted = allowlistFixture(f.files);
    a.strictEqual(restarted.api.isAllowed('apple.com'), true);
    a.strictEqual(restarted.api.activePresets().apple, 3);
  } },
  { name: 'successful exact grant and revoke survive fresh module load', fn: a => {
    const f = allowlistFixture();
    a.strictEqual(f.api.addExact('only.test').ok, true);
    const restarted = allowlistFixture(f.files);
    a.strictEqual(restarted.api.isAllowed('only.test'), true);
    a.strictEqual(restarted.api.removeExact('only.test').ok, true);
    a.strictEqual(allowlistFixture(f.files).api.isAllowed('only.test'), false);
  } },
  { name: 'site panel closes on navigation and stale open reply cannot resurrect it', fn: async a => {
    const f = uiFixture(); f.update(1, 'https://one.test/a');
    const first = f.context.open();
    f.update(1, 'https://two.test/b');
    f.pending[0].resolve({ origin: 'https://one.test', host: 'one.test', tabId: 1, counts: {}, sessionCounts: {} });
    await first;
    a.strictEqual(f.el('site-menu').classList.contains('hidden'), true);
  } },
  { name: 'site panel ignores out-of-order replies after two open requests', fn: async a => {
    const f = uiFixture(); f.update(1, 'https://one.test/a');
    const old = f.context.open(), latest = f.context.open();
    const info = host => ({ origin: `https://${host}`, host, tabId: 1, counts: {}, sessionCounts: {} });
    f.pending[1].resolve(info('one.test')); await latest;
    f.pending[0].resolve(info('stale.test')); await old;
    a.strictEqual(f.el('site-menu-host').textContent, 'one.test');
  } },
  { name: 'open site panel closes on tab switch and rejects mismatched status', fn: async a => {
    const f = uiFixture(); f.update(1, 'https://one.test/a');
    const info = { origin: 'https://one.test', host: 'one.test', tabId: 1, counts: {}, sessionCounts: {} };
    const first = f.context.open(); f.pending[0].resolve(info); await first;
    a.strictEqual(f.el('site-menu').classList.contains('hidden'), false);
    f.update(2, 'https://two.test/b');
    a.strictEqual(f.el('site-menu').classList.contains('hidden'), true);
    const second = f.context.open(); f.pending[1].resolve(info); await second;
    a.strictEqual(f.el('site-menu').classList.contains('hidden'), true);
  } },
  { name: 'site exception persistence error restores switch and displays reason', fn: async a => {
    const f = uiFixture(); f.update(1, 'https://one.test/a');
    const info = { origin: 'https://one.test', host: 'one.test', tabId: 1, counts: {}, sessionCounts: {} };
    const opened = f.context.open(); f.pending[0].resolve(info); await opened;
    f.context.F.siteException = async () => ({ ok: false, reason: 'fixture disk denied' });
    const control = f.el('site-allow-check'); control.checked = true;
    const changed = control.events.change({ target: control });
    f.pending[1].resolve(info); await changed;
    a.strictEqual(control.checked, false);
    a.strictEqual(f.el('site-result').textContent, 'fixture disk denied');
  } },
];
