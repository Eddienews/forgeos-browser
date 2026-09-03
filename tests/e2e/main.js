/*
 * tests/e2e/main.js — browser-level integration checks (Gates A–G/K, and the
 * Final Validation items that require a real renderer).
 *
 * Runs inside real Electron/Chromium. All traffic is LOCAL (localhost /
 * 127.0.0.1 loopback) plus blocked ad/tracker hosts, which the adapter never
 * lets reach the network. No third-party websites are contacted.
 *
 * Usage: electron tests/e2e/main.js
 * Prints one JSON summary line and exits 0/1.
 */
'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { FilterEngine } = require('../../src/engine/filter-engine');
const { EventLog } = require('../../src/engine/event-log');
const { SessionAdapter } = require('../../src/ext/electron-adapter');
const { analyzeAgentView, IN_PAGE_SCRIPT } = require('../../src/engine/agent-view');
const { createPageWebPreferences } = require('../../src/page-web-preferences');

const PAGES = path.join(__dirname, '..', 'pages');
const PNG1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SILENT_WAV = (() => {
  const sampleRate = 8000;
  const dataSize = sampleRate;
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
})();
const results = [];
let server = null;
let port = 0;

function record(test, name, pass, detail) {
  results.push({ test, name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${test}] ${name}${pass ? '' : '  — ' + detail}`);
}

function serve() {
  server = http.createServer((req, res) => {
    // Third-party endpoint: sets a cookie on a DIFFERENT host (Test C).
    if (req.url.startsWith('/3p.gif')) {
      res.writeHead(200, { 'content-type': 'image/gif', 'set-cookie': 'partner=123; Path=/; Max-Age=3600' });
      res.end(PNG1PX);
      return;
    }
    if (req.url.startsWith('/ok.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG1PX);
      return;
    }
    if (req.url.startsWith('/silent.wav')) {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': SILENT_WAV.length });
      res.end(SILENT_WAV);
      return;
    }
    if (req.url.startsWith('/autoplay.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><audio id="probe" autoplay loop src="/silent.wav"></audio>');
      return;
    }
    const clean = req.url.split('?')[0].replace(/^\/+/, '');
    const file = path.join(PAGES, clean);
    if (!file.startsWith(PAGES) || !fs.existsSync(file)) {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = fs.readFileSync(file, 'utf8');
    if (clean === 'cookies.html') {
      // First-party cookie set on the document response (Test B).
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'forge_1p=hello; Path=/' });
      body = body.split('127.0.0.1:PORT').join('127.0.0.1:' + port);
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadAndWait(wc, url) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('did-fail-load', onFail);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onFail = (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`navigation failed (${code} ${description}): ${validatedURL}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigation timeout: ${url}; current=${wc.getURL()}; loading=${wc.isLoading()}`));
    }, 20000);
    wc.once('did-finish-load', onFinish);
    wc.on('did-fail-load', onFail);
    // Electron's loadURL promise can remain pending after an otherwise complete
    // renderer navigation. The browser shell itself is event-driven, so the
    // E2E harness intentionally observes the same completion events.
    wc.loadURL(url).catch((error) => {
      cleanup();
      reject(error);
    });
  });
  await sleep(500); // settle subresources
}

async function main() {
  await app.whenReady();
  const p = await serve();
  console.log(`e2e server on localhost:${p} and 127.0.0.1:${p}`);

  const PART = 'forge-e2e-' + Date.now();
  const ses = session.fromPartition(PART);
  const eventLog = new EventLog(null, 5000);
  const engine = new FilterEngine({});
  const adapter = new SessionAdapter({ session: ses, engine, log: eventLog, modeId: 'standard', getChromeWindow: () => null, onDownloadRecord: () => {} });
  adapter.install();

  const win = new BrowserWindow({
    show: false,
    webPreferences: createPageWebPreferences({ partition: PART }),
  });
  const wc = win.webContents;

  /* ---------- Gate A: browser + engine launch ---------- */
  record('A', 'browser window created, engine + adapter installed', true,
    'electron ' + process.versions.electron + ' / chromium ' + process.versions.chrome);

  /* ---------- Gate K: restored media must wait for the user ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/autoplay.html`);
  const playback = await wc.executeJavaScript(`(() => {
    const media = document.getElementById('probe');
    return { paused: media.paused, currentTime: media.currentTime, readyState: media.readyState };
  })()`);
  record('K', 'media page stays paused until user activation',
    playback.paused === true && playback.currentTime < 0.05 && playback.readyState >= 2,
    JSON.stringify(playback));

  /* ---------- Test A (Gates B/C): ad/tracker requests blocked ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/ad_tracking.html`);
  const ad = await wc.executeJavaScript('({ adLoaded: !!window.__adLoaded, gaLoaded: !!window.__gaLoaded, okLoaded: !!window.__okLoaded })');
  record('A', 'advertising request blocked (Test A)',
    ad.okLoaded === true && ad.adLoaded === false && ad.gaLoaded === false, JSON.stringify(ad));

  /* ---------- Tests B & C (Gate D): cookies ---------- */
  await loadAndWait(wc, `http://localhost:${p}/cookies.html`);
  const names = (await ses.cookies.get({})).map((c) => c.name);
  record('B', 'first-party cookies (server + JS) allowed',
    names.includes('forge_1p') && names.includes('session_js'), 'jar=' + names.join(','));
  record('C', 'third-party cookie blocked',
    !names.includes('partner'), 'jar=' + names.join(','));

  /* ---------- Test D (Gate E): tracking URL cleanup ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/clean.html?utm_source=test&utm_campaign=e2e&id=10&fbclid=x`);
  const finalUrl = wc.getURL();
  const inPage = await wc.executeJavaScript('window.__finalUrl');
  record('D', 'tracking parameters removed from navigation',
    !/utm_source|fbclid/.test(finalUrl) && /id=10/.test(finalUrl), `final=${finalUrl}`);
  record('D', 'page observed the cleaned URL',
    !/utm_source|fbclid/.test(inPage || ''), `inPage=${inPage}`);

  /* ---------- Test E (Gate G): prompt injection ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/prompt_injection.html`);
  const raw = await wc.executeJavaScript(IN_PAGE_SCRIPT, true);
  const av = analyzeAgentView(raw, { trackersBlocked: { ads: 0, trackers: 0, thirdParty: 0, params: 0 }, modeId: 'standard' });
  const sev = av.security.prompt_injection_severity;
  const okE = av.security.prompt_injection_detected && (sev === 'CRITICAL' || sev === 'HIGH') &&
    av.security.instruction_authority === false && av.security.untrusted === true &&
    av.security.prompt_injection_findings.length >= 2 &&
    String(raw.bodyText || '').includes('Ignore previous instructions');
  record('E', 'prompt injection detected (severity ' + sev + ')', okE,
    'findings=' + av.security.prompt_injection_findings.map((f) => f.severity + ':' + f.label).join(' | '));

  /* ---------- Test F (Gate H): agent cannot silently upload ---------- */
  const upload = require('../../src/engine/permissions').requestAction('UPLOAD_FILE', { filename: 'notes.txt' });
  record('F', 'agent cannot silently upload files (approval required)', upload.verdict === 'ASK', 'verdict=' + upload.verdict);

  /* ---------- Test G (Gate F): password never reaches agent context ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/forms.html`);
  const fav = analyzeAgentView(await wc.executeJavaScript(IN_PAGE_SCRIPT, true), {});
  const inp = fav.content.inputs || [];
  const redacted = inp.every((i) => !String(i.value).includes('hunter2')) &&
    inp.some((i) => i.type === 'password' && i.value === '<REDACTED>') &&
    inp.some((i) => i.name === 'cc_number' && i.value === '<REDACTED>');
  const visible = inp.some((i) => i.name === 'username' && i.value === 'someone');
  record('G', 'password & card values never reach agent context', redacted && visible,
    'inputs=' + JSON.stringify(inp.map((i) => ({ n: i.name, v: i.value, s: i.sensitive }))));

  /* ---------- Phase 7: exposure study (documented, not claimed protected) ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/fingerprint.html`);
  const fp = await wc.executeJavaScript('window.__fp');
  record('7', 'fingerprint exposure channels recorded for study',
    !!(fp && typeof fp.canvas === 'boolean' && Array.isArray(fp.languages) && typeof fp.tzOffset === 'number'),
    'channels=' + Object.keys(fp || {}).join(','));

  // Run privileged-global inspection in a disposable renderer after the
  // navigation journey. Electron's inspector-side property probe can retain
  // wrapper state, so this renderer is deliberately never navigated again.
  const boundaryWin = new BrowserWindow({
    show: false,
    webPreferences: createPageWebPreferences({ partition: PART + '-boundary' }),
  });
  await loadAndWait(boundaryWin.webContents, `http://127.0.0.1:${p}/clean.html`);
  const boundary = await boundaryWin.webContents.executeJavaScript(`({
    processType: typeof window.process,
    requireType: typeof window.require,
    forgeType: typeof window.forge,
    electronType: typeof window.electron
  })`);
  const boundarySafe = boundary.processType === 'undefined' && boundary.requireType === 'undefined' &&
    boundary.forgeType === 'undefined' && boundary.electronType === 'undefined';
  record('K', 'real page has no Node, Electron, or chrome bridge access', boundarySafe,
    JSON.stringify(boundary));
  boundaryWin.destroy();

  const payload = {
    results,
    adapterCounters: adapter.counters,
    fingerprintChannels: fp ? Object.keys(fp) : [],
  };
  console.log('\n=== E2E SUMMARY ===');
  console.log(JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'results', 'e2e-results.json'), JSON.stringify(payload, null, 2));

  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failed} FAILURES`);
  win.destroy();
  server.close();
  app.exit(failed === 0 ? 0 : 1);
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('E2E CRASH:', e); app.exit(2); });
