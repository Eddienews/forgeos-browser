'use strict';
// Real application integration for HTTPS-only mode and Save as PDF.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-https-e2e-'));
app.setPath('userData', scratch);
// Two public-looking names that resolve to this machine, so the upgrade applies
// without any request leaving it.
const HOST_A = 'forge-e2e-plain-a.example.com';
const HOST_B = 'forge-e2e-plain-b.example.com';
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${HOST_A} 127.0.0.1, MAP ${HOST_B} 127.0.0.1`);

const plainRequests = [];
const server = http.createServer((req, res) => {
  plainRequests.push(`${req.headers.host}${req.url}`);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Plain fixture</title><h1>plain http page</h1>');
});
server.on('clientError', (_error, socket) => socket.destroy()); // a TLS hello on a plain port
const checks = [];
function check(name, ok, detail) { checks.push({ name, pass: !!ok, detail }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 12000) {
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

async function main() {
  require('../../src/main');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  const settingsBefore = await ui(win, 'window.forge.settingsGet()');
  await ui(win, 'window.forge.settingsSet({ httpsOnly: true })');

  const prompts = [];
  let answer = 0;
  dialog.showMessageBox = async (_window, options) => { prompts.push(options); return { response: answer }; };

  try {
    // 1. Declined: the plain-HTTP page is never requested.
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://${HOST_A}:${port}/first`)})`);
    await until(() => prompts.length === 1);
    await sleep(500);
    check('a failed secure retry asks the human', /could not be opened over HTTPS/.test(prompts[0].message) &&
      prompts[0].message.includes(HOST_A) && prompts[0].defaultId === 0 && prompts[0].cancelId === 0, prompts[0].message);
    check('declining sends nothing over plain HTTP', plainRequests.length === 0 &&
      !String(page(win).getURL()).startsWith('http://'), JSON.stringify([plainRequests, page(win).getURL()]));

    // 2. Accepted: the page loads over HTTP, and the choice holds for that host.
    answer = 1;
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://${HOST_A}:${port}/second`)})`);
    await until(() => page(win).getURL() === `http://${HOST_A}:${port}/second` && !page(win).isLoading());
    check('accepting loads the page over HTTP', prompts.length === 2 &&
      await page(win).executeJavaScript('document.title') === 'Plain fixture');
    check('the toolbar marks the page as not secure', await ui(win,
      "window.forge.getState().then(s => (s.tabs.find(t => t.id === s.activeTabId) || {}).security.label) ") === 'NOT SECURE');
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://${HOST_A}:${port}/third`)})`);
    await until(() => page(win).getURL() === `http://${HOST_A}:${port}/third` && !page(win).isLoading());
    check('the allowed host is not asked again this session', prompts.length === 2);

    // 3. The allowance is per host.
    answer = 0;
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://${HOST_B}:${port}/other`)})`);
    await until(() => prompts.length === 3);
    await sleep(400);
    check('another host is still upgraded and asked about', prompts[2].message.includes(HOST_B) &&
      !plainRequests.some(r => r.startsWith(HOST_B)), JSON.stringify(plainRequests));

    // 4. Loopback is exempt: local development keeps working.
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://127.0.0.1:${port}/local`)})`);
    await until(() => page(win).getURL() === `http://127.0.0.1:${port}/local` && !page(win).isLoading());
    check('loopback addresses are not upgraded', prompts.length === 3);

    // 5. Switched off: plain HTTP loads directly.
    await ui(win, 'window.forge.settingsSet({ httpsOnly: false })');
    await ui(win, `window.forge.navigate(${JSON.stringify(`http://${HOST_B}:${port}/off`)})`);
    await until(() => page(win).getURL() === `http://${HOST_B}:${port}/off` && !page(win).isLoading());
    check('with HTTPS-only off, HTTP loads without a prompt', prompts.length === 3);
    await ui(win, 'window.forge.settingsSet({ httpsOnly: true })');

    // 6. Save as PDF writes a real PDF where the human chose.
    const pdf = path.join(scratch, 'saved page.pdf');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf });
    const saved = await ui(win, 'window.forge.savePdf()');
    check('Save as PDF writes a PDF file', saved && saved.ok === true && fs.existsSync(pdf) &&
      fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-', JSON.stringify(saved));
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(scratch, 'not-a-pdf.html') });
    const refused = await ui(win, 'window.forge.savePdf()');
    check('a destination that is not .pdf is refused', refused && refused.ok === false &&
      !fs.existsSync(path.join(scratch, 'not-a-pdf.html')));
  } finally {
    // Development runs keep settings in the checkout: put the switch back.
    await ui(win, `window.forge.settingsSet({ httpsOnly: ${settingsBefore.httpsOnly !== false} })`).catch(() => {});
  }
}

main()
  .catch((error) => check('HTTPS-only E2E completed', false, String((error && error.stack) || error).slice(0, 600)))
  .finally(() => {
    const failed = checks.filter(c => !c.pass);
    console.log('HTTPS_ONLY_E2E ' + JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }));
    server.close();
    app.exit(failed.length ? 1 : 0);
  });
