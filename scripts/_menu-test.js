/* _menu-test.js — load chrome UI, click the gear programmatically, report. */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const w = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  w.webContents.on('console-message', (_e, level, message) => {
    if (String(message).includes('Security Warning')) return;
    console.log('PAGE:', String(message).slice(0, 200));
  });
  w.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 800));
    // 1) does the button exist and have a listener-eligible state?
    const probe1 = await w.webContents.executeJavaScript(
      `({ btn: !!document.getElementById('btn-gear'), menu: !!document.getElementById('gear-menu'),
         menuHidden: document.getElementById('gear-menu')?.classList.contains('hidden') })`, true);
    console.log('PROBE1:', JSON.stringify(probe1));
    // 2) click it like a user would
    await w.webContents.executeJavaScript(
      `document.getElementById('btn-gear').click()`, true);
    await new Promise((r) => setTimeout(r, 300));
    const probe2 = await w.webContents.executeJavaScript(
      `({ menuHiddenAfterClick: document.getElementById('gear-menu')?.classList.contains('hidden'),
          rows: document.querySelectorAll('#gear-menu .menu-row').length })`, true);
    console.log('PROBE2 (after .click()):', JSON.stringify(probe2));
    // 3) simulate a real mouse event sequence
    await w.webContents.executeJavaScript(`
      const b = document.getElementById('btn-gear');
      const r = b.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
      b.dispatchEvent(new MouseEvent('mousedown', opts));
      b.dispatchEvent(new MouseEvent('mouseup', opts));
      b.dispatchEvent(new MouseEvent('click', opts));
    `, true);
    await new Promise((r) => setTimeout(r, 300));
    const probe3 = await w.webContents.executeJavaScript(
      `({ menuHiddenFinal: document.getElementById('gear-menu')?.classList.contains('hidden') })`, true);
    console.log('PROBE3 (after synthetic mouse events):', JSON.stringify(probe3));
    app.exit(0);
  }).catch((e) => { console.log('LOAD FAIL:', String(e)); app.exit(1); });
});