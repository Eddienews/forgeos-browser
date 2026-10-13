'use strict';
// Real application integration for keyboard shortcuts and links handed over by
// another launch of the browser.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shortcuts-e2e-')));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Page ${req.url}</title><input id="field" autofocus><script>
    window.keys = []; addEventListener('keydown', e => window.keys.push((e.ctrlKey ? 'ctrl+' : '') + e.key));</script>`);
});
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
const page = (win) => win.contentView.children.at(-1)?.webContents;
const state = (win) => ui(win, 'window.forge.getState()');
function press(wc, keyCode, modifiers = []) {
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function main() {
  require('../../src/main');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  await ui(win, `window.forge.navigate(${JSON.stringify(origin + '/one')})`);
  await until(() => page(win)?.getURL() === origin + '/one' && !page(win).isLoading());
  const first = page(win);
  const firstId = (await state(win)).activeTabId;
  const start = (await state(win)).tabs.length;

  // Ctrl+T from a focused page: new tab, address bar focused, page never saw the key.
  press(first, 'T', ['control']);
  await until(async () => (await state(win)).tabs.length === start + 1);
  await until(() => ui(win, "document.activeElement && document.activeElement.id === 'addr'"));
  check('Ctrl+T opens a tab and focuses the address bar', true);
  check('the page did not receive the shortcut', !(await first.executeJavaScript('window.keys')).includes('ctrl+t'));
  const secondId = (await state(win)).activeTabId;
  check('the new tab is active', secondId !== firstId);

  // Typed while the address bar has focus: handled by the toolbar window.
  press(win.webContents, 'Tab', ['control']);
  await until(async () => (await state(win)).activeTabId === firstId);
  check('Ctrl+Tab cycles to the next tab from the toolbar', true);
  press(page(win), 'Tab', ['control', 'shift']);
  await until(async () => (await state(win)).activeTabId === secondId);
  check('Ctrl+Shift+Tab cycles back from a page', true);
  press(win.webContents, '1', ['control']);
  await until(async () => (await state(win)).activeTabId === firstId);
  check('Ctrl+1 selects the first tab', true);

  // Ordinary typing is left for the page: the browser does not cancel it.
  // (Observed in the main process, so it does not depend on OS window focus.)
  const verdicts = [];
  const observe = (event, input) => { if (input.type === 'keyDown') verdicts.push([input.key, input.control, event.defaultPrevented]); };
  page(win).on('before-input-event', observe);
  press(page(win), 'T');
  press(page(win), 'F1');
  press(page(win), 'C', ['control']);
  await sleep(300);
  page(win).off('before-input-event', observe);
  check('plain keys and page shortcuts are not cancelled',
    verdicts.length === 3 && verdicts.every((v) => v[2] === false) && (await state(win)).tabs.length === start + 1,
    JSON.stringify(verdicts));

  // Ctrl+L focuses the address bar; Alt+Left goes back after a navigation.
  press(page(win), 'L', ['control']);
  await until(() => ui(win, "document.activeElement && document.activeElement.id === 'addr'"));
  check('Ctrl+L focuses the address bar', true);
  await ui(win, `window.forge.navigate(${JSON.stringify(origin + '/two')})`);
  await until(() => page(win)?.getURL() === origin + '/two' && !page(win).isLoading());
  press(page(win), 'Left', ['alt']);
  await until(() => page(win)?.getURL() === origin + '/one');
  check('Alt+Left goes back', true);

  // Zoom.
  press(page(win), '=', ['control']);
  await until(() => Math.abs(page(win).getZoomFactor() - 1.1) < 0.01);
  press(page(win), '0', ['control']);
  await until(() => Math.abs(page(win).getZoomFactor() - 1) < 0.01);
  check('Ctrl+= zooms in and Ctrl+0 resets', true);

  // A second launch hands over its links; anything that is not http(s) is ignored.
  const before = (await state(win)).tabs.length;
  app.emit('second-instance', {}, ['forge', '--flag', origin + '/external', 'file:///etc/passwd', 'javascript:alert(1)']);
  await until(async () => (await state(win)).tabs.length === before + 1);
  await until(() => page(win)?.getURL() === origin + '/external' && !page(win).isLoading());
  await sleep(400);
  const after = await state(win);
  check('a second launch opens exactly its http(s) link in a new tab', after.tabs.length === before + 1 &&
    !JSON.stringify(after.tabs).includes('passwd'));
  check('the handed-over page has no chrome bridge',
    await page(win).executeJavaScript("typeof window.forge === 'undefined' && typeof window.require === 'undefined'"));

  // Ctrl+Shift+T brings back the tab just closed.
  await ui(win, 'window.forge.newTab()');
  await ui(win, `window.forge.navigate(${JSON.stringify(origin + '/reopen-me')})`);
  await until(() => page(win)?.getURL() === origin + '/reopen-me' && !page(win).isLoading());
  const withReopen = (await state(win)).tabs.length;
  press(page(win), 'W', ['control']);
  await until(async () => (await state(win)).tabs.length === withReopen - 1);
  press(page(win), 'T', ['control', 'shift']);
  await until(async () => (await state(win)).tabs.length === withReopen);
  await until(() => page(win)?.getURL() === origin + '/reopen-me' && !page(win).isLoading());
  check('Ctrl+Shift+T reopens the closed tab at its address', true);
  press(page(win), 'T', ['control', 'shift']);
  await sleep(500);
  check('nothing reopens when no closed tab is remembered', (await state(win)).tabs.length === withReopen);

  // A forget-on-close tab is forgotten: it cannot be brought back.
  await ui(win, 'window.forge.newTab()');
  await ui(win, `window.forge.navigate(${JSON.stringify(origin + '/forget-me')})`);
  await until(() => page(win)?.getURL() === origin + '/forget-me' && !page(win).isLoading());
  await ui(win, 'window.forge.setForgetOnClose(true)');
  const withForget = (await state(win)).tabs.length;
  press(page(win), 'W', ['control']);
  await until(async () => (await state(win)).tabs.length === withForget - 1);
  press(page(win), 'T', ['control', 'shift']);
  await sleep(600);
  const afterForget = await state(win);
  check('a forget-on-close tab is not reopened', afterForget.tabs.length === withForget - 1 &&
    !JSON.stringify(afterForget.tabs).includes('forget-me'));

  // Clearing the session also forgets closed tabs.
  press(page(win), 'W', ['control']);
  await until(async () => (await state(win)).tabs.length === withForget - 2);
  await ui(win, 'window.forge.clearSession()');
  press(page(win), 'T', ['control', 'shift']);
  await sleep(600);
  check('Clear Session forgets closed tabs', (await state(win)).tabs.length === withForget - 2);

  // Ctrl+W closes; closing the last tab leaves a fresh blank one, not an empty window.
  let remaining = (await state(win)).tabs.length;
  while (remaining > 1) {
    press(page(win), 'W', ['control']);
    const expected = remaining - 1;
    try { await until(async () => (await state(win)).tabs.length === expected, 4000); }
    catch (error) {
      const s = await state(win);
      throw new Error(`Ctrl+W did not close: tabs=${JSON.stringify(s.tabs.map(x => [x.id, x.url]))} active=${s.activeTabId} pageUrl=${JSON.stringify(page(win).getURL())}`);
    }
    remaining = expected;
  }
  check('Ctrl+W closes tabs one at a time', remaining === 1);
  const lastId = (await state(win)).activeTabId;
  press(page(win), 'W', ['control']);
  await until(async () => { const s = await state(win); return s.tabs.length === 1 && s.activeTabId !== lastId; });
  check('closing the last tab opens a fresh blank tab', true);
}

main()
  .catch((error) => check('shortcuts E2E completed', false, String((error && error.stack) || error).slice(0, 600)))
  .finally(() => {
    const failed = checks.filter(c => !c.pass);
    console.log('SHORTCUTS_E2E ' + JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }));
    server.close();
    app.exit(failed.length ? 1 : 0);
  });
