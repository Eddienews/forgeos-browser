/* _detect-probe.js — what does Google's bot-detector see in our page env? */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'page-preload.js'),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  await w.loadURL('data:text/html,<html><body>x</body></html>');
  await new Promise((r) => setTimeout(r, 600));
  const probe = await w.webContents.executeJavaScript(`({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    hasProcess: typeof window.process !== 'undefined',
    electronVer: (typeof window.process !== 'undefined' && window.process.versions) ? window.process.versions.electron : null,
    pluginsLen: navigator.plugins.length,
    chromeObj: typeof window.chrome,
    automationKeys: Object.keys(window).filter(k => /cdc|driver|automation|phantom|selenium|__nightmare/i.test(k)),
    permissions: typeof navigator.permissions,
    notificationPerm: (typeof Notification !== 'undefined') ? Notification.permission : 'n/a'
  })`);
  console.log('PROBE:', JSON.stringify(probe, null, 1));
  app.exit(0);
}).catch((e) => { console.log('ERR', String(e)); app.exit(1); });