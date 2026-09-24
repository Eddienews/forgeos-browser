'use strict';
// Real application/UI integration, not a simulated find controller.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const reportPath = path.join(__dirname, '..', '..', 'results', 'find-e2e-results.json');
const scratch = process.env.BH_AGENT_WORKSPACE || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
fs.mkdirSync(scratch, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(scratch, 'forge-find-e2e-')));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Find fixture</title><p>amber amber amber</p>');
});
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, pass: !!ok, detail });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(75);
  }
  throw new Error('Timed out waiting for ' + fn.toString().slice(0, 80));
}
async function ui(win, script) { return win.webContents.executeJavaScript(script); }
function page(win) { return win.contentView.children[0]?.webContents; }
function key(wc, code, modifiers = []) {
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
}
async function main() {
  // Use the real production main process, preload, renderer, and tab view.
  require('../../src/main');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  const wc = page(win);
  const found = [];
  wc.on('found-in-page', (_event, result) => found.push(result));
  check('untrusted page has no chrome bridge or Node',
    await wc.executeJavaScript("typeof window.forge === 'undefined' && typeof window.require === 'undefined'"));
  key(wc, 'F', ['control']);
  await until(() => ui(win, "!document.querySelector('#find-bar').classList.contains('hidden')"));
  check('Ctrl+F from page opens chrome find panel',
    await ui(win, "document.activeElement.id === 'find-query'"));
  check('page view is below find panel', win.contentView.children[0].getBounds().y === 84,
    JSON.stringify(win.contentView.children[0].getBounds()));
  await ui(win, "document.querySelector('#find-query').value = 'amber'; document.querySelector('#find-query').dispatchEvent(new Event('input', {bubbles:true}))");
  try { await until(() => ui(win, "document.querySelector('#find-count').textContent === '1 / 3'")); }
  catch (error) {
    throw new Error(`${error.message}; actual=${JSON.stringify(await ui(win, "({ count: document.querySelector('#find-count').textContent, value: document.querySelector('#find-query').value, open: !document.querySelector('#find-bar').classList.contains('hidden') })"))}; native=${JSON.stringify(found)}; bridge=${await ui(win, "window.forge.findSearch('amber', 'forward')")}; url=${wc.getURL()}`);
  }
  check('native Chromium find reports first of three matches', true);
  key(win.webContents, 'F3');
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '2 / 3'"));
  check('F3 advances to second match', true);
  key(win.webContents, 'F3', ['shift']);
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '1 / 3'"));
  check('Shift+F3 returns to first match', true);
  key(wc, 'F3');
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '2 / 3'"));
  check('F3 from page content advances native match', true);
  await ui(win, "document.querySelector('#find-prev').click()");
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '1 / 3'"));
  await ui(win, "document.querySelector('#find-next').click()");
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '2 / 3'"));
  check('previous and next panel buttons move the active match', true);
  await ui(win, "document.querySelector('#find-query').value = 'not-on-page'; document.querySelector('#find-query').dispatchEvent(new Event('input', {bubbles:true}))");
  await until(() => found.some(result => result.finalUpdate && result.matches === 0));
  check('no-match query displays zero matches', await ui(win, "document.querySelector('#find-count').textContent === '0 / 0'"));
  key(wc, 'Escape');
  await until(() => ui(win, "document.querySelector('#find-bar').classList.contains('hidden')"));
  check('Escape from page closes and restores page bounds', win.contentView.children[0].getBounds().y === 42);
  // Reopen and navigate: search must not leak to another document.
  await ui(win, 'window.forge.findOpen()');
  await ui(win, "window.forge.findSearch('amber', 'forward')");
  await until(() => ui(win, "document.querySelector('#find-count').textContent === '1 / 3'"));
  await ui(win, `window.forge.navigate(${JSON.stringify(url + '?next=1')})`);
  await until(() => ui(win, "document.querySelector('#find-bar').classList.contains('hidden')"));
  check('main-frame navigation resets find state', win.contentView.children[0].getBounds().y === 42);
  // A new tab switch also clears selection and cannot retain the query.
  await ui(win, 'window.forge.findOpen()');
  await ui(win, "window.forge.findSearch('amber', 'forward')");
  await ui(win, 'window.forge.newTab()');
  await until(() => ui(win, "document.querySelector('#find-bar').classList.contains('hidden')"));
  check('tab switch closes find and clears query', await ui(win, "document.querySelector('#find-query').value === ''"));
  check('agent-readable state excludes find query', !JSON.stringify(await ui(win, 'window.forge.getState()')).includes('amber'));

  // Production toolbar IPC -> named persistent Electron partitions -> page cookies.
  await ui(win, "document.querySelector('[data-container=work]').click()");
  const workState = await until(() => ui(win, "window.forge.getState().then(s => s.tabs.find(t => t.containerId === 'work') || null)"));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  await page(win).executeJavaScript("document.cookie='container_fixture=work; Path=/'");
  check('Work container created by UI has persistent isolated partition',
    page(win).session.getStoragePath() != null && page(win).session !== require('electron').session.defaultSession);
  await ui(win, "document.querySelector('[data-container=personal]').click()");
  await until(() => ui(win, "window.forge.getState().then(s => s.tabs.some(t => t.containerId === 'personal'))"));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  check('Personal container cannot see Work cookie',
    !(await page(win).executeJavaScript('document.cookie')).includes('container_fixture='));
  await ui(win, `window.forge.closeTab(${workState.id})`);
  const reopened = await ui(win, "window.forge.newTab('about:blank', 'work')");
  await until(() => ui(win, `window.forge.getState().then(s => s.tabs.some(t => t.id === ${reopened.id} && t.containerId === 'work'))`));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  check('Work cookie survives tab close and reopening same container',
    (await page(win).executeJavaScript('document.cookie')).includes('container_fixture=work'));
  const modeChange = await ui(win, "window.forge.setMode('strict')");
  check('privacy mode cannot silently move named tabs into another jar',
    modeChange.ok === false && (await ui(win, 'window.forge.getState()')).mode === 'standard');
}
(async () => {
  try { await main(); }
  catch (error) { check('harness', false, String(error.stack || error)); }
  const payload = { passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length, checks };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  console.log('FIND_E2E ' + JSON.stringify(payload));
  server.close();
  app.exit(payload.failed ? 1 : 0);
})();
