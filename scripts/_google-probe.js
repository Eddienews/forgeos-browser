/* _google-probe.js — load the actual Google sign-in page in our env and dump
 * every signal Google's anti-bot checks. Read-only diagnostic. */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

setTimeout(async () => {
  try {
    const { BrowserWindow } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); }

    // Navigate via forge API (same path a user takes)
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://accounts.google.com/v3/signin/identifier?continue=https://www.youtube.com/')`);
    await new Promise((r) => setTimeout(r, 8000));

    // Find the page WebContentsView's webContents (the youtube/google tab)
    const { webContents } = require('electron');
    const all = webContents.getAllWebContents();
    const page = all.find((wc) => (wc.getURL() || '').includes('accounts.google.com'));
    if (!page) {
      console.log('PAGE NOT FOUND. urls:', all.map((w) => w.getURL()).slice(0, 5));
      app.exit(1);
      return;
    }
    const probe = await page.executeJavaScript(`({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      pluginsLen: navigator.plugins.length,
      languages: navigator.languages,
      chromeRuntime: !!(window.chrome && window.chrome.runtime),
      chromeApp: !!(window.chrome && window.chrome.app),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      screenW: screen.width + 'x' + screen.height,
      webglVendor: (() => { try { const c = document.createElement('canvas').getContext('webgl'); const ext = c.getExtension('WEBGL_debug_renderer_info'); return c.getParameter(ext.UNMASKED_RENDERER_WEBGL); } catch (e) { return 'ERR'; } })(),
      notifPerm: (typeof Notification !== 'undefined') ? Notification.permission : 'n/a',
      docHidden: document.hidden,
      iframeDepth: window !== window.top
    })`, true).catch((e) => ({ execErr: String(e).slice(0, 150) }));
    console.log('GOOGLE-ENV:', JSON.stringify(probe, null, 1));
  } catch (e) {
    console.log('ERR', String(e).slice(0, 200));
  }
  app.exit(0);
}, 7000);