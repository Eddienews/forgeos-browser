'use strict';
// Real application/UI integration for remembered per-site permissions:
// production main process, preload, toolbar renderer, and a sandboxed page.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'forge-site-perm-e2e-')));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Permission fixture</title><p>permission fixture</p>');
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
const page = (win) => win.contentView.children[0]?.webContents;
const query = (wc, name) => wc.executeJavaScript(
  `navigator.permissions.query({ name: ${JSON.stringify(name)} }).then(r => r.state, e => 'error: ' + e.message)`);
const stored = (win, permission) => ui(win,
  `window.forge.sitePrivacy().then(s => s && (s.permissions.find(p => p.permission === ${JSON.stringify(permission)}) || {}).state)`);
const choose = (win, permission, value) => ui(win, `(() => {
  const control = document.getElementById('site-perm-' + ${JSON.stringify(permission)});
  control.value = ${JSON.stringify(value)};
  control.dispatchEvent(new Event('change', { bubbles: true }));
})()`);

async function main() {
  require('../../src/main');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const otherOrigin = `http://localhost:${port}/`;
  const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()));
  await until(() => page(win));
  await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
  await until(() => page(win)?.getURL() === url && !page(win).isLoading());
  const wc = page(win);

  // The approval prompts are native and modal. Count them, and answer the
  // async "always allow" confirmation; a synchronous prompt here is a failure.
  let syncPrompts = 0;
  let confirmations = 0;
  let confirmAnswer = 1;
  dialog.showMessageBoxSync = () => { syncPrompts += 1; return 0; };
  dialog.showMessageBox = async () => { confirmations += 1; return { response: confirmAnswer }; };

  try {
    check('page starts with camera and location unavailable',
      await query(wc, 'camera') === 'denied' && await query(wc, 'geolocation') === 'denied');

    await ui(win, "(document.querySelector('.badge') || document.getElementById('security-badge')).click()");
    await until(() => ui(win, "!document.getElementById('site-menu').classList.contains('hidden')"));
    const bounds = await ui(win, `(() => {
      const r = document.getElementById('site-menu').getBoundingClientRect();
      const c = document.getElementById('site-perm-clipboard-read').getBoundingClientRect();
      return { left: r.left, right: r.right, controlRight: c.right, width: window.innerWidth };
    })()`);
    check('site panel and its controls stay inside the window',
      bounds.left >= 0 && bounds.right <= bounds.width && bounds.controlRight <= bounds.width, JSON.stringify(bounds));
    check('site panel lists every managed permission as Ask', await ui(win,
      "['media','geolocation','notifications','clipboard-read'].every(p => document.getElementById('site-perm-' + p).value === 'ask')"));

    // Block: no confirmation needed, and the page is refused without a prompt.
    await choose(win, 'geolocation', 'deny');
    await until(async () => await stored(win, 'geolocation') === 'deny');
    check('Block is stored without a confirmation dialog', confirmations === 0);
    const denied = await wc.executeJavaScript(`new Promise(resolve => navigator.geolocation.getCurrentPosition(
      () => resolve('granted'), error => resolve('error ' + error.code), { timeout: 4000 }))`);
    check('blocked location request is refused without prompting', denied === 'error 1' && syncPrompts === 0,
      `${denied}; prompts=${syncPrompts}`);

    // Always allow: cancelling the native confirmation changes nothing.
    confirmAnswer = 0;
    await choose(win, 'media', 'allow');
    await until(() => confirmations === 1);
    await until(() => ui(win, "document.getElementById('site-perm-media').value === 'ask' && !document.getElementById('site-perm-media').disabled"));
    check('cancelled Always allow leaves the permission on Ask',
      await stored(win, 'media') === 'ask' && await query(wc, 'camera') === 'denied');

    confirmAnswer = 1;
    await choose(win, 'media', 'allow');
    await until(async () => await stored(win, 'media') === 'allow');
    check('confirmed Always allow is visible to the page', confirmations === 2 &&
      await query(wc, 'camera') === 'granted' && await query(wc, 'microphone') === 'granted');
    check('other permissions on the same site stay unavailable',
      await query(wc, 'notifications') === 'denied' && await query(wc, 'geolocation') === 'denied');

    // A different origin on the same host and port number sees nothing.
    await ui(win, `window.forge.navigate(${JSON.stringify(otherOrigin)})`);
    await until(() => page(win)?.getURL() === otherOrigin && !page(win).isLoading());
    check('a different origin does not inherit the grant', await query(page(win), 'camera') === 'denied');
    check('the other origin shows its own state', await stored(win, 'media') === 'ask');

    // Reset to Ask on the original site withdraws the grant.
    await ui(win, `window.forge.navigate(${JSON.stringify(url)})`);
    await until(() => page(win)?.getURL() === url && !page(win).isLoading());
    await ui(win, "(document.querySelector('.badge') || document.getElementById('security-badge')).click()");
    await until(() => ui(win, "!document.getElementById('site-menu').classList.contains('hidden')"));
    check('reopened panel shows the remembered choices', await ui(win,
      "document.getElementById('site-perm-media').value === 'allow' && document.getElementById('site-perm-geolocation').value === 'deny'"));
    await choose(win, 'media', 'ask');
    await until(async () => await stored(win, 'media') === 'ask');
    check('reset to Ask withdraws the grant', await query(page(win), 'camera') === 'denied');
    check('the page never obtained a chrome bridge',
      await page(win).executeJavaScript("typeof window.forge === 'undefined' && typeof window.require === 'undefined'"));
    check('no synchronous permission prompt was shown', syncPrompts === 0, String(syncPrompts));
  } finally {
    // Dev runs keep data in the checkout: leave no remembered decision behind.
    for (const permission of ['media', 'geolocation']) {
      try { await ui(win, `window.forge.sitePermission(${JSON.stringify(permission)}, 'ask')`); } catch {}
    }
  }
}

main()
  .catch((error) => check('site permission E2E completed', false, String((error && error.stack) || error).slice(0, 600)))
  .finally(() => {
    const failed = checks.filter(c => !c.pass);
    console.log('SITE_PERMISSIONS_E2E ' + JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }));
    server.close();
    app.exit(failed.length ? 1 : 0);
  });
