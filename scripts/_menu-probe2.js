/* _menu-probe2.js — click badge, check menu visibility + preset rows. */
'use strict';
const { app } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

setTimeout(async () => {
  try {
    const { BrowserWindow } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); }
    // navigate the active tab to youtube first (via forge API)
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://www.youtube.com/')`);
    await new Promise((r) => setTimeout(r, 5000));
    const probe = await chromeWin.webContents.executeJavaScript(`(async () => {
      const out = {};
      const state = window.__lastState || null;
      // grab state via forge.onState is event-based; instead read DOM addr
      out.addr = document.getElementById('addr') ? document.getElementById('addr').value : '?';
      const badge = document.getElementById('sec-badge');
      out.badgeText = badge ? badge.textContent : '?';
      if (badge) badge.click();
      await new Promise(r => setTimeout(r, 600));
      const sm = document.getElementById('site-menu');
      out.siteMenuExists = !!sm;
      out.siteMenuHiddenAfterClick = sm ? sm.classList.contains('hidden') : 'n/a';
      out.presetRows = sm ? sm.querySelectorAll('#preset-list .menu-row').length : 0;
      out.gearMenuAlsoOpen = !document.getElementById('gear-menu').classList.contains('hidden');
      return out;
    })()`);
    console.log('PROBE2:', JSON.stringify(probe, null, 1));
  } catch (e) {
    console.log('ERR', String(e).slice(0, 300));
  }
  app.exit(0);
}, 7000);