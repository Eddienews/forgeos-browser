/* _webgl-instrument.js — check whether our prototype patches exist in the page. */
'use strict';
const { app } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

setTimeout(async () => {
  try {
    const { BrowserWindow, webContents } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); return; }
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://coveryourtracks.eff.org/')`);
    await new Promise((r) => setTimeout(r, 8000));
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('coveryourtracks'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }

    const probe = await page.executeJavaScript(`(() => {
      const rpStr = WebGLRenderingContext.prototype.readPixels.toString();
      const duStr = HTMLCanvasElement.prototype.toDataURL.toString();
      return {
        readPixelsPatched: /farble|prng|orig\\.call/.test(rpStr) || rpStr.includes('[native code]') === false,
        readPixelsSrc: rpStr.slice(0, 80),
        toDataURLNative: duStr.includes('[native code]'),
        ua: navigator.userAgent.slice(0, 60),
        hw: navigator.hardwareConcurrency,
      };
    })()`);
    console.log('INSTRUMENT:', JSON.stringify(probe, null, 1));
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);