/* _turtlecute-audit.js — capture ALL requests on the turtlecute test page
 * and classify: blocked vs passed, per host. Reveals exactly which of the
 * 132 checks pass through. */
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

    // Find page webContents after navigation and attach CDP for FULL request log
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://adblock.turtlecute.org/')`);
    await new Promise((r) => setTimeout(r, 2500));
    const { webContents } = require('electron');
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('turtlecute'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }

    const dbg = page.debugger;
    dbg.attach('1.3');
    const requests = new Map(); // requestId -> {url, blocked}
    dbg.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        requests.set(params.requestId, { url: params.request.url, blocked: false });
      }
      if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
        requests.get(params.requestId).blocked = true; // canceled = we blocked it
      }
    });
    await dbg.sendCommand('Network.enable');

    // Run the actual test click
    await page.executeJavaScript(`document.querySelector('button, .test-button, [onclick]')?.click?.() || document.body.click()`);
    await new Promise((r) => setTimeout(r, 15000));

    // Also check cosmetic state
    const cosmetic = await page.executeJavaScript(`(() => {
      const vis = (sel) => [...document.querySelectorAll(sel)].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      }).length;
      return {
        adboxVisible: vis('.adbox'), bannerAdsVisible: vis('.banner_ads'),
        adsboxVisible: vis('.adsbox'), textadsVisible: vis('.textads'),
      };
    })()`).catch(() => ({ err: 'page navigated away or JS failed' }));

    let blockedCount = 0, passedCount = 0;
    const passedHosts = new Map();
    for (const r of requests.values()) {
      if (!r.url.includes('turtlecute')) continue; // only test's own probes
      if (r.blocked) { blockedCount++; continue; }
      passedCount++;
      try {
        const h = new URL(r.url).hostname;
        passedHosts.set(h, (passedHosts.get(h) || 0) + 1);
      } catch {}
    }
    console.log(`TEST PROBES: ${blockedCount} blocked, ${passedCount} PASSED`);
    console.log('PASSED HOSTS (these are the "not blocked" points):');
    for (const [h, c] of [...passedHosts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${c}x ${h}`);
    }
    console.log('COSMETIC:', JSON.stringify(cosmetic));
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);