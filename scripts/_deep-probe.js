/* _deep-probe.js — the signals we have NOT yet checked, on accounts.google.com.
 * Focus: what Chrome has that embedded Chromium lacks. */
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
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://accounts.google.com/v3/signin/identifier?continue=https://www.youtube.com/')`);
    await new Promise((r) => setTimeout(r, 6000));
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('accounts.google.com'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }

    const probe = await page.executeJavaScript(`(() => {
      const out = {};
      // 1. window.chrome surface
      out.chromeKeys = window.chrome ? Object.keys(window.chrome).sort() : null;
      out.runtimeSubkeys = (window.chrome && window.chrome.runtime) ? Object.keys(window.chrome.runtime).length : 0;
      // 2. csi/loadTimes (old but real-Chrome markers)
      out.chromeCSI = !!(window.chrome && window.chrome.csi);
      out.chromeLoadTimes = !!(window.chrome && window.chrome.loadTimes);
      // 3. Permissions.query behavior for notifications (Chrome returns 'prompt',
      //    embedded often throws or returns different)
      out.permissionsQuery = 'unset';
      try {
        navigator.permissions.query({ name: 'notifications' }).then((r) => { window.__permResult = r.state; }).catch((e) => { window.__permResult = 'ERR:' + String(e).slice(0,40); });
      } catch (e) { out.permissionsQuery = 'THROW'; }
      // 4. Plugin array realism
      out.pluginNames = [...navigator.plugins].map(p => p.name);
      // 5. MediaDevices
      out.mediaDevices = !!navigator.mediaDevices;
      // 6. Notification.permission value
      out.notifPerm = typeof Notification !== 'undefined' ? Notification.permission : 'n/a';
      // 7. iframe / window.top access
      out.sameOriginTop = false;
      try { out.canReadTop = !!window.top.location.href; } catch (e) { out.canReadTop = 'blocked (normal cross-origin)'; }
      return out;
    })()`);
    console.log('DEEP:', JSON.stringify(probe, null, 1));
    await new Promise((r) => setTimeout(r, 800));
    const perm = await page.executeJavaScript('window.__permResult || "pending"');
    console.log('PERM_QUERY_RESULT:', perm);
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);