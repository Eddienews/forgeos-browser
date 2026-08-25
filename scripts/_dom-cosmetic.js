/* _dom-cosmetic.js — DOM removal for cosmetic matches (not just CSS hiding).
 * Runs at document_end: removes matched elements entirely. Turtlecute counts
 * "ad box REMOVED" as blocked; display:none does not count. */
'use strict';
const { app } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

// Verify on turtlecute: after DOM removal, are the boxes GONE from the DOM?
setTimeout(async () => {
  try {
    const { BrowserWindow, webContents } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); return; }
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://adblock.turtlecute.org/')`);
    await new Promise((r) => setTimeout(r, 9000));
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('turtlecute'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }
    const probe = await page.executeJavaScript(`(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        adboxInDOM: q('.adbox'), bannerAdsInDOM: q('.banner_ads'),
        adsboxInDOM: q('.adsbox'), textadsInDOM: q('.textads'),
      };
    })()`);
    console.log('DOM STATE:', JSON.stringify(probe));
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);