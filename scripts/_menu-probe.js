/* _menu-probe.js — drive the real chrome window: click badge, dump menu state. */
'use strict';
const { app } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

// After boot, inspect the chrome window's DOM through its webContents.
setTimeout(async () => {
  try {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle && w.getTitle() !== '');
    const wc = (BrowserWindow.getAllWindows()[0] || {}).webContents;
    if (!wc) { console.log('NO WINDOW'); app.exit(1); }
    // Find the chrome renderer (loads index.html)
    for (const w of BrowserWindow.getAllWindows()) {
      const url = w.webContents.getURL();
      console.log('window url:', url.slice(0, 60));
    }
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); }
    const probe = await chromeWin.webContents.executeJavaScript(`(async () => {
      const out = {};
      out.hasForge = typeof window.forge !== 'undefined';
      out.hasPresetsList = !!(window.forge && window.forge.presetsList);
      if (out.hasPresetsList) {
        try { out.presets = await window.forge.presetsList(); } catch (e) { out.presetsErr = String(e); }
      }
      const badge = document.getElementById('sec-badge');
      out.badgeExists = !!badge;
      // simulate the badge click
      if (badge) badge.click();
      await new Promise(r => setTimeout(r, 400));
      const sm = document.getElementById('site-menu');
      out.siteMenuHiddenAfterClick = sm ? sm.classList.contains('hidden') : 'no-element';
      out.presetRows = document.querySelectorAll('#preset-list .menu-row').length;
      return out;
    })()`);
    console.log('PROBE:', JSON.stringify(probe, null, 1));
  } catch (e) {
    console.log('ERR', String(e).slice(0, 300));
  }
  app.exit(0);
}, 6000);