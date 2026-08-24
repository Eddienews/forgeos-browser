/* _full-ui-test.js — load REAL chrome UI with FULL main.js, click gear via DOM,
   then toggle the checkbox and verify settings file changes. */
'use strict';
process.env.FORGE_DEBUG_CONSOLE = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
// Reuse the real app but intercept its window: easier to spawn the real main
// in a child? No — require it. main.js runs app.whenReady itself.
require(path.join(__dirname, '..', 'src', 'main.js'));

// After ready, find chromeWin via defaultPrimaryDisplay hack: main keeps it
// private; instead we use Electron's window list.
const { BrowserWindow: BW } = require('electron');
setTimeout(async () => {
  const wins = BW.getAllWindows();
  console.log('WINDOWS:', wins.length);
  const w = wins.find((x) => x.getTitle && x.getTitle() === 'ForgeOS Browser') || wins[0];
  if (!w) { console.log('NO WINDOW'); app.exit(1); return; }
  await new Promise((r) => setTimeout(r, 500));
  // Click gear like a user (real DOM event)
  const r1 = await w.webContents.executeJavaScript(`
    (function () {
      const b = document.getElementById('btn-gear');
      if (!b) return 'NO BUTTON';
      b.click();
      const m = document.getElementById('gear-menu');
      return 'menu hidden after click: ' + m.classList.contains('hidden');
    })()
  `, true);
  console.log('GEAR:', r1);
  // Now uncheck blockAds checkbox programmatically (fires change event)
  const r2 = await w.webContents.executeJavaScript(`
    (function () {
      const cb = document.getElementById('set-blockads');
      if (!cb) return 'NO CHECKBOX';
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return 'dispatched change, checked=' + cb.checked;
    })()
  `, true);
  console.log('TOGGLE:', r2);
  await new Promise((r) => setTimeout(r, 600));
  // Read back through IPC from the page context
  const r3 = await w.webContents.executeJavaScript(`window.forge.settingsGet()`, true);
  console.log('SETTINGS READBACK: blockAds =', r3.blockAds);
  console.log('FILE EXISTS:', require('fs').existsSync(require('path').join(__dirname, '..', 'forge-settings.json')));
  app.exit(0);
}, 4000);
