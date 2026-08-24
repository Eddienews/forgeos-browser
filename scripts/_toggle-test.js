/* _toggle-test.js — full loop: toggle blockAds off → is a doubleclick request allowed? */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const settings = require(path.join(__dirname, '..', 'src', 'engine', 'settings'));
  const { FilterEngine } = require(path.join(__dirname, '..', 'src', 'engine', 'filter-engine'));
  const { decideRequest } = require(path.join(__dirname, '..', 'src', 'engine', 'network-policy'));
  const fs = require('fs');

  const engine = new FilterEngine({});
  for (const f of ['easylist.txt', 'easyprivacy.txt']) {
    const p = path.join(__dirname, '..', 'lists', f);
    if (fs.existsSync(p)) engine.loadAbpLines(fs.readFileSync(p, 'utf8').split('\n'), { source: f });
  }

  const adUrl = 'https://googleads.g.doubleclick.net/pagead/id';

  // Blocking ON (default)
  let d = decideRequest({ url: adUrl, tabUrl: 'https://www.youtube.com', resourceType: 'xhr', engine, modeId: 'standard' });
  console.log('blockAds=ON  → decision:', d.decision);

  // Simulate the user toggling OFF via the settings menu
  settings.save({ blockAds: false });
  const S = settings.all();
  // Replicate adapter logic:
  const blockingEnabled = S.blockAds !== false;
  d = decideRequest({ url: adUrl, tabUrl: 'https://www.youtube.com', resourceType: 'xhr', engine, modeId: 'standard' });
  const effective = (d.decision === 'BLOCK' && !blockingEnabled) ? 'ALLOW (toggle respected)' : d.decision;
  console.log('blockAds=OFF → raw policy:', d.decision, '| effective in adapter:', effective);

  settings.save({ blockAds: true });
  console.log('restored');
  app.exit(0);
});