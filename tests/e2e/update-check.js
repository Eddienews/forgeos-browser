'use strict';
// Real application integration for the update notice. No request leaves the
// machine: the feed is answered by a stub and github.com resolves to loopback.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-e2e-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1');

const feedCalls = [];
let feed = () => { throw new Error('offline'); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.github.com/')) { feedCalls.push([String(url), options]); return feed(); }
  return realFetch(url, options);
};
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

const checks = [];
function check(name, ok, detail) { checks.push({ name, pass: !!ok, detail }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(75);
  }
  throw new Error('Timed out waiting for ' + fn.toString().slice(0, 100));
}
const ui = (win, script) => win.webContents.executeJavaScript(script);
const page = (win) => win.contentView.children[0]?.webContents;
const label = (win) => ui(win, "({ text: document.getElementById('app-version').textContent, marked: document.getElementById('app-version').classList.contains('update-available'), line: document.getElementById('update-line').textContent })");

async function main() {
  require('../../src/main');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  const version = app.getVersion();
  const settingsBefore = await ui(win, 'window.forge.settingsGet()');
  try {
    await sleep(1500);
    check('a build run from source makes no automatic request', feedCalls.length === 0);
    await until(async () => (await label(win)).text === `v${version}`);
    check('the toolbar shows the running version with no update mark', !(await label(win)).marked);

    // A failed check says so and marks nothing.
    await ui(win, "document.getElementById('mi-update-check').click()");
    await until(async () => (await label(win)).line === 'Updates: could not check');
    check('a failed check reports that it could not check', feedCalls.length === 1 && !(await label(win)).marked);

    // Up to date.
    feed = () => reply({ tag_name: 'v' + version });
    await ui(win, "document.getElementById('mi-update-check').click()");
    await until(async () => (await label(win)).line === 'Updates: up to date');
    check('the same version is reported as up to date', !(await label(win)).marked);

    // A newer release: marked, and the response's own links are ignored.
    feed = () => reply({ tag_name: 'v999.0.0', html_url: 'https://evil.test/malware' });
    await ui(win, "document.getElementById('mi-update-check').click()");
    await until(async () => (await label(win)).marked);
    const shown = await label(win);
    check('a newer release marks the toolbar version', shown.text === `v${version} ↑` &&
      shown.line === 'Updates: version 999.0.0 is available', JSON.stringify(shown));
    check('the request disclosed nothing about this installation',
      !JSON.stringify(feedCalls).includes(version) && feedCalls.every(([, o]) => o.credentials === 'omit' && !o.body));

    // Clicking the mark opens this project's release page in a normal tab.
    const tabsBefore = (await ui(win, 'window.forge.getState()')).tabs.length;
    await ui(win, "document.getElementById('app-version').click()");
    await until(async () => (await ui(win, 'window.forge.getState()')).tabs.length === tabsBefore + 1);
    const expected = 'https://github.com/Eddienews/forgeos-browser/releases/tag/v999.0.0';
    await until(() => page(win).getURL() === expected, 15000);
    check('the mark opens the project release page, never a link from the response', page(win).getURL() === expected);

    // A later failure keeps what was already known.
    feed = () => { throw new Error('offline'); };
    await ui(win, "document.getElementById('mi-update-check').click()");
    await sleep(600);
    check('a later failed check keeps the known update', (await label(win)).marked);

    // The switch is stored and reported.
    await ui(win, "(() => { const c = document.getElementById('set-updates'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await until(async () => (await ui(win, 'window.forge.updateStatus()')).enabled === false);
    check('turning the check off is stored', (await ui(win, 'window.forge.settingsGet()')).checkForUpdates === false);
  } finally {
    await ui(win, `window.forge.settingsSet({ checkForUpdates: ${settingsBefore.checkForUpdates !== false} })`).catch(() => {});
  }
}

main()
  .catch((error) => check('update check E2E completed', false, String((error && error.stack) || error).slice(0, 600)))
  .finally(() => {
    const failed = checks.filter(c => !c.pass);
    console.log('UPDATE_CHECK_E2E ' + JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }));
    app.exit(failed.length ? 1 : 0);
  });
