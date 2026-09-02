/*
 * test-public-adblock.js — non-gating live ad-block benchmark.
 *
 * These third-party sites and their scores can change without notice, so this
 * suite is intentionally separate from `npm run verify`. It runs with the same
 * FilterEngine, SessionAdapter, EasyList/EasyPrivacy cosmetic rules, and page
 * sandbox as ForgeOS Browser, but uses fresh in-memory sessions and never reads
 * or modifies the user's browser profile.
 *
 * Usage:
 *   npm run test:adblock:public
 *   npm run test:adblock:public -- --target=turtlecute
 */
'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const { FilterEngine } = require('../src/engine/filter-engine');
const { EventLog } = require('../src/engine/event-log');
const { SessionAdapter } = require('../src/ext/electron-adapter');
const { compileCosmetic, selectorsForHost } = require('../src/engine/cosmetic-engine');
const { createPageWebPreferences } = require('../src/page-web-preferences');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  { id: 'turtlecute', label: 'TurtleCute', url: 'https://adblock.turtlecute.org/' },
  { id: 'adblock-tester', label: 'AdBlock Tester', url: 'https://adblock-tester.com/' },
  { id: 'broad-186', label: 'Adblock Tester 186', url: 'https://adblocktester.pages.dev/?lang=en' },
  { id: 'canyoublockit', label: 'Can You Block It — Extreme', url: 'https://canyoublockit.com/extreme-test/' },
  { id: 'd3ward', label: 'd3ward (archived)', url: 'https://d3ward.github.io/toolz/adblock', informational: true },
];

function selectedTargets() {
  const arg = process.argv.find((value) => value.startsWith('--target='));
  if (!arg) return TARGETS;
  const id = arg.slice('--target='.length).trim();
  const target = TARGETS.find((entry) => entry.id === id);
  if (!target) throw new Error(`Unknown target '${id}'. Use: ${TARGETS.map((entry) => entry.id).join(', ')}`);
  return [target];
}

function loadFilters() {
  const engine = new FilterEngine({});
  const cosmeticLines = [];
  for (const name of ['easylist.txt', 'easyprivacy.txt']) {
    const lines = fs.readFileSync(path.join(ROOT, 'lists', name), 'utf8').split('\n');
    engine.loadAbpLines(lines, { source: name });
    for (const line of lines) {
      if (line.includes('##') || line.includes('#@#')) cosmeticLines.push(line);
    }
  }
  return { engine, cosmetic: compileCosmetic(cosmeticLines) };
}

function safeSelectors(cosmetic, host) {
  return [...new Set([...(cosmetic.genericSelectors || []), ...selectorsForHost(cosmetic, host)])]
    .filter((selector) => selector && selector.length < 200 && !/[:{}]/.test(selector))
    .slice(0, 4000);
}

function scoreFrom(text) {
  const turtle = text.match(/Total\s*:?\s*(\d+)\s+(\d+)\s+blocked\s+(\d+)\s+not blocked/i);
  if (turtle) {
    const total = Number(turtle[1]);
    const blocked = Number(turtle[2]);
    return { total, blocked, open: Number(turtle[3]), percent: Math.round(blocked * 1000 / total) / 10 };
  }
  const points = text.match(/(\d+)\s*points?\s*out of\s*100/i);
  if (points) return { total: 100, blocked: Number(points[1]), open: 100 - Number(points[1]), percent: Number(points[1]) };
  const broad = text.match(/(\d+)%\s*(\d+)\s*\/\s*(\d+)\s*Blocked/i);
  if (broad) return { total: Number(broad[3]), blocked: Number(broad[2]), open: Number(broad[3]) - Number(broad[2]), percent: Number(broad[1]) };
  return null;
}

async function runTarget(target, index) {
  const { engine, cosmetic } = loadFilters();
  const partition = `forge-public-adblock-${Date.now()}-${index}`;
  const ses = session.fromPartition(partition);
  const eventLog = new EventLog(null, 10000);
  const adapter = new SessionAdapter({
    session: ses,
    engine,
    log: eventLog,
    modeId: 'standard',
    getChromeWindow: () => null,
    onDownloadRecord: () => {},
  });
  adapter.install();

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: createPageWebPreferences({ partition }),
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  const applyCosmetic = async (url) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const hostSelectors = selectorsForHost(cosmetic, host);
    const css = [
      cosmetic.genericCss,
      ...hostSelectors.map((selector) => `${selector}{display:none!important}`),
    ].filter(Boolean).join('\n');
    if (css) await wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});

    const selectors = safeSelectors(cosmetic, host);
    if (!selectors.length) return;
    const script = `(function(){for(const sel of ${JSON.stringify(selectors)}){try{document.querySelectorAll(sel).forEach(el=>el&&el.parentNode&&el.parentNode.removeChild(el))}catch{}}})()`;
    await wc.executeJavaScript(script, true).catch(() => {});
  };

  wc.on('did-navigate', (_event, url) => { applyCosmetic(url).catch(() => {}); });
  try {
    await wc.loadURL(target.url);
    await applyCosmetic(wc.getURL());
    await new Promise((resolve) => setTimeout(resolve, 15000));
    await applyCosmetic(wc.getURL());
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const page = await wc.executeJavaScript(`(() => {
      const text = document.body ? document.body.innerText : '';
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
      };
      const bait = '.adbox,.adsbox,.banner_ads,.ad-banner,#ad-container,.adsbygoogle,.google-ad,.textads';
      return {
        title: document.title,
        url: location.href,
        text: text.slice(0, 120000),
        visibleBaits: Array.from(document.querySelectorAll(bait)).filter(visible).length,
        visibleIframes: Array.from(document.querySelectorAll('iframe')).filter(visible).length,
      };
    })()`, true);
    return {
      id: target.id,
      label: target.label,
      url: page.url,
      title: page.title,
      informational: !!target.informational,
      score: scoreFrom(page.text),
      explicitChecks: {
        passed: (page.text.match(/test passed/gi) || []).length,
        failed: (page.text.match(/test (?:has most likely )?failed/gi) || []).length,
      },
      visibleBaits: page.visibleBaits,
      visibleIframes: page.visibleIframes,
      blockedRequests: {
        ads: adapter.counters.ads,
        trackers: adapter.counters.trackers,
        analytics: adapter.counters.analytics,
        thirdParty: adapter.counters.thirdParty,
        cookies: adapter.counters.cookies,
      },
    };
  } catch (error) {
    return { id: target.id, label: target.label, url: target.url, error: String(error && error.message || error).slice(0, 300) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  await app.whenReady();
  const targets = selectedTargets();
  const results = [];
  fs.writeSync(1, '=== FORGEOS PUBLIC ADBLOCK BENCHMARK (NON-GATING) ===\n');
  for (let index = 0; index < targets.length; index++) {
    const result = await runTarget(targets[index], index);
    results.push(result);
    const score = result.score ? `${result.score.percent}% (${result.score.blocked}/${result.score.total})` : 'qualitative only';
    fs.writeSync(1, `${result.error ? 'ERROR' : 'RESULT'} ${result.label}: ${result.error || score}\n`);
  }
  fs.writeSync(1, `FORGE_PUBLIC_ADBLOCK_JSON:${JSON.stringify({ generatedAt: new Date().toISOString(), electron: process.versions.electron, chromium: process.versions.chrome, results })}\n`);
  app.exit(results.some((result) => result.error) ? 1 : 0);
}

main().catch((error) => {
  fs.writeSync(2, String(error && error.stack || error) + '\n');
  app.exit(1);
});
