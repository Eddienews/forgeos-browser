/* _hdr-capture3.js — sniff WITHOUT overwriting the adapter's handler.
 * Electron merges multiple listeners? No — last one wins. So instead of
 * registering our own onBeforeSendHeaders, we log from INSIDE via a
 * debugger attach (Network.requestWillBeSentExtraInfo shows final headers). */
'use strict';
const { app, session } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

setTimeout(async () => {
  try {
    const { BrowserWindow } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); return; }

    // Find the PAGE webContents (tab), attach CDP to it
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://accounts.google.com/v3/signin/identifier?continue=https://www.youtube.com/')`);
    await new Promise((r) => setTimeout(r, 3000));
    const { webContents } = require('electron');
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('accounts.google.com'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }
    const dbg = page.debugger;
    dbg.attach('1.3');
    let shown = 0;
    dbg.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSentExtraInfo' && shown < 2) {
        shown++;
        console.log(`=== FINAL HEADERS #${shown} ===`);
        for (const [k, v] of Object.entries(params.headers || {})) {
          if (/cookie|:method|:path|:authority|:scheme/i.test(k)) continue;
          console.log(`${k}: ${v}`);
        }
      }
    });
    await dbg.sendCommand('Network.enable');
    // reload so the request fires through the adapter handler
    page.reload();
    await new Promise((r) => setTimeout(r, 9000));
    console.log('=== DONE ===');
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);