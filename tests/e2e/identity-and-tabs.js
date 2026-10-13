'use strict';
// Real application integration for two page-visible behaviours:
//  - request headers describe the same browser JavaScript reports;
//  - a link asking for a new window becomes a ForgeOS tab only after user input.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'forge-identity-e2e-')));
const seen = new Map(); // path -> request headers
const server = http.createServer((req, res) => {
  seen.set(req.url, req.headers);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url.startsWith('/next')
    ? '<!doctype html><title>Opened</title><p>opened</p>'
    : `<!doctype html><title>Identity fixture</title>
       <a id="blank" href="/next?from=link" target="_blank"
          style="position:fixed;left:20px;top:20px;display:block;width:240px;height:60px;background:#ccc">open</a>`);
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
const tabCount = (win) => ui(win, 'window.forge.getState().then(s => s.tabs.length)');

async function main() {
  require('../../src/main');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // localhost is a secure context, so client hints and userAgentData both apply.
  const origin = `http://localhost:${server.address().port}`;
  const url = origin + '/';
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  const wc = page(win);

  /* ---- identity: headers agree with JavaScript ---- */
  const js = await wc.executeJavaScript(`({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData && navigator.userAgentData.platform,
    brands: navigator.userAgentData && navigator.userAgentData.brands.map(b => '"' + b.brand + '";v="' + b.version + '"').join(', '),
  })`);
  const headers = seen.get('/') || {};
  check('User-Agent header equals navigator.userAgent and hides Electron',
    headers['user-agent'] === js.userAgent && !/Electron|Forge/i.test(headers['user-agent']), headers['user-agent']);
  check('Sec-CH-UA repeats the brands JavaScript reports', !!js.brands && headers['sec-ch-ua'] === js.brands,
    `header=${headers['sec-ch-ua']} js=${js.brands}`);
  check('Sec-CH-UA-Platform equals navigator.userAgentData.platform',
    !!js.platform && headers['sec-ch-ua-platform'] === `"${js.platform}"`,
    `header=${headers['sec-ch-ua-platform']} js=${js.platform}`);
  check('no request header claims Google Chrome', !/Google Chrome/i.test(JSON.stringify(headers)));
  check('the full version list is not volunteered', headers['sec-ch-ua-full-version-list'] === undefined);

  /* ---- new-window requests ---- */
  const windowsBefore = BrowserWindow.getAllWindows().length;
  const before = await tabCount(win);
  // Script-initiated, no user input: refused.
  await wc.executeJavaScript(`void window.open(${JSON.stringify(origin + '/next?from=script')}, '_blank')`);
  await sleep(700);
  check('window.open without user input opens nothing',
    await tabCount(win) === before && !seen.has('/next?from=script'));

  // A real click on a target=_blank link: opens one ForgeOS tab.
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 40, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 40, button: 'left', clickCount: 1 });
  await until(async () => await tabCount(win) === before + 1);
  await until(() => page(win)?.getURL() === origin + '/next?from=link' && !page(win).isLoading());
  check('clicked target=_blank link opens exactly one new tab at its destination', await tabCount(win) === before + 1);
  check('the new tab has no opener and no chrome bridge', await page(win).executeJavaScript(
    "window.opener === null && typeof window.forge === 'undefined' && typeof window.require === 'undefined'"));
  check('no native child window was created', BrowserWindow.getAllWindows().length === windowsBefore);
  // The same input cannot be reused for a second window.
  await wc.executeJavaScript(`void window.open(${JSON.stringify(origin + '/next?from=reuse')}, '_blank')`);
  await sleep(700);
  check('one user action opens at most one tab', await tabCount(win) === before + 1 && !seen.has('/next?from=reuse'));
}

main()
  .catch((error) => check('identity and tabs E2E completed', false, String((error && error.stack) || error).slice(0, 600)))
  .finally(() => {
    const failed = checks.filter(c => !c.pass);
    console.log('IDENTITY_TABS_E2E ' + JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }));
    server.close();
    app.exit(failed.length ? 1 : 0);
  });
