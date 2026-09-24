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
const os = require('os');
const path = require('path');

const { FilterEngine } = require('../../src/engine/filter-engine');
const { EventLog } = require('../../src/engine/event-log');
const { SessionAdapter } = require('../../src/ext/electron-adapter');
const { analyzeAgentView, IN_PAGE_SCRIPT } = require('../../src/engine/agent-view');
const { forgeSnapshotScript } = require('../../src/page-snapshot');
const { forgeActionScript } = require('../../src/page-actions');
const { normalizeSnapshot } = require('../../src/engine/page-snapshot');
const { compareAgentPreview, hashEffectProof } = require('../../src/engine/action-policy');
const { candidatesFor } = require('../../src/engine/typesafe-decider');
const { createPageWebPreferences } = require('../../src/page-web-preferences');
const sessionStore = require('../../src/engine/session-store');
const { containerPartition, sessionPlanFor } = require('../../src/engine/storage-manager');
const { clearOriginData } = require('../../src/engine/site-privacy');
const allowlist = require('../../src/engine/site-allowlist');
const { runAgentProxyE2E } = require('./agent-proxy');
const { runQuicE2E } = require('./quic');
const { runNotebookE2E } = require('./research-notebook');

// The Electron integration process must not reuse the user's browser profile.
const scratchRoot = process.env.BH_AGENT_WORKSPACE || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratchProfile = fs.mkdtempSync(path.join(scratchRoot, 'forge-agent-e2e-'));
app.setPath('userData', scratchProfile);

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
    if (req.url.startsWith('/approval-display/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><input type="password" value="fixtureDialogPath93">
        <button type="button" id="approve">fixtureDialogPath93</button>`);
      return;
    }
    if (req.url.startsWith('/editable-sensitive/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Article fixtureEditable74</title>
        <span id="editable-label">Password</span>
        <div contenteditable="true" aria-labelledby="editable-label">fixtureEditable74</div>
        <p>Ordinary prose and fixtureEditable74</p>
        <a href="/next/fixtureEditable74/%66%69%78%74%75%72%65%45%64%69%74%61%62%6c%65%37%34">Read fixtureEditable74</a>`);
      return;
    }
    if (req.url.startsWith('/associated-label/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Article fixtureOnlyLabel76</title>
        <label for="ordinary">Password</label><input type="text" id="ordinary" name="ordinary" value="fixtureOnlyLabel76">
        <span id="other-label">Password</span><input type="text" name="ordinary2" aria-labelledby="other-label" value="fixtureOnlyLabel76">
        <p>Article fixtureOnlyLabel76</p>
        <a href="/next/fixtureOnlyLabel76/%66%69%78%74%75%72%65%4f%6e%6c%79%4c%61%62%65%6c%37%36">Read fixtureOnlyLabel76</a>`);
      return;
    }
    if (req.url.startsWith('/snapshot-duplication/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Article fixturePathValue78</title>
        <input type="password" name="password" value="fixturePathValue78">
        <a href="/next/fixturePathValue78/%66%69%78%74%75%72%65%50%61%74%68%56%61%6c%75%65%37%38">Read fixturePathValue78</a>
        <a style="position:absolute;top:1400px" href="/later/fixturePathValue78">Later fixturePathValue78</a>`);
      return;
    }
    if (req.url.startsWith('/privacy-script.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.__privacyLoaded = true');
      return;
    }
    if (req.url.startsWith('/privacy-subrequest')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><script referrerpolicy="no-referrer" src="http://127.0.0.1:${port}/privacy-script.js"></script>`);
      return;
    }
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
      res.end(`<!doctype html>
        <button id="play" style="position:absolute;left:0;top:0;width:120px;height:60px">Play</button>
        <audio id="probe" autoplay loop src="/silent.wav"></audio>
        <script>
          window.__playEvents = 0;
          probe.addEventListener('play', () => { window.__playEvents += 1; });
          play.addEventListener('click', () => probe.play());
        </script>`);
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

  /* ---------- Named human container cookie isolation ---------- */
  const containerUrl = `http://127.0.0.1:${p}/cookies.html`;
  const workPlan = sessionPlanFor(containerUrl, 'standard', false, 'work');
  const personalPlan = sessionPlanFor(containerUrl, 'standard', false, 'personal');
  const workJar = session.fromPartition(workPlan.partition);
  const personalJar = session.fromPartition(personalPlan.partition);
  await workJar.cookies.set({ url: containerUrl, name: 'container_fixture', value: 'work-only' });
  const [workCookies, personalCookies] = await Promise.all([
    session.fromPartition(containerPartition('work')).cookies.get({ url: containerUrl, name: 'container_fixture' }),
    personalJar.cookies.get({ url: containerUrl, name: 'container_fixture' }),
  ]);
  record('CONTAINERS', 'same named container shares jar; different container cannot read its cookie',
    workCookies.length === 1 && workCookies[0].value === 'work-only' && personalCookies.length === 0,
    `work=${workCookies.length}, personal=${personalCookies.length}`);
  await personalJar.cookies.set({ url: containerUrl, name: 'container_fixture', value: 'personal-only' });
  await workJar.clearStorageData({ origin: new URL(containerUrl).origin, storages: ['cookies'] });
  const [afterWork, afterPersonal] = await Promise.all([
    workJar.cookies.get({ url: containerUrl, name: 'container_fixture' }),
    personalJar.cookies.get({ url: containerUrl, name: 'container_fixture' }),
  ]);
  record('CONTAINERS', 'clearing work container does not clear personal',
    afterWork.length === 0 && afterPersonal.length === 1 && afterPersonal[0].value === 'personal-only',
    `work=${afterWork.length}, personal=${afterPersonal.length}`);

  const PART = 'forge-e2e-' + Date.now();
  const ses = session.fromPartition(PART);
  const eventLog = new EventLog(null, 5000);
  const engine = new FilterEngine({});
  const siteHits = [];
  const adapter = new SessionAdapter({ session: ses, engine, log: eventLog, modeId: 'standard', getChromeWindow: () => null, onDownloadRecord: () => {}, onSiteBlocked: (id, category) => siteHits.push({ id, category }) });
  adapter.install();

  const win = new BrowserWindow({
    show: false,
    webPreferences: createPageWebPreferences({ partition: PART }),
  });
  const wc = win.webContents;

  /* ---------- Gate A: browser + engine launch ---------- */
  record('LAUNCH', 'browser window created, engine + adapter installed', true,
    'electron ' + process.versions.electron + ' / chromium ' + process.versions.chrome);

  /* ---------- Gate K: restored media must wait for the user ---------- */
  const mediaUrl = `http://127.0.0.1:${p}/autoplay.html`;
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-media-restore-'));
  sessionStore.captureOpenTabs(new Map([[1, {
    url: mediaUrl, forgetOnClose: false, restoreOnRestart: true,
  }]]), restoreDir);
  const restoredMediaUrl = sessionStore.restoreTabs(restoreDir)[0];
  sessionStore.clear(restoreDir);
  fs.rmSync(restoreDir, { recursive: true, force: true });
  record('K', 'media URL passes through crash-recovery persistence',
    restoredMediaUrl === mediaUrl, `restored=${restoredMediaUrl || 'none'}`);
  await loadAndWait(wc, restoredMediaUrl);
  const playback = await wc.executeJavaScript(`(() => {
    const media = document.getElementById('probe');
    return { paused: media.paused, currentTime: media.currentTime, readyState: media.readyState, playEvents: window.__playEvents };
  })()`);
  record('K', 'restored media page stays paused until user activation',
    playback.paused === true && playback.currentTime < 0.05 && playback.readyState >= 2 && playback.playEvents === 0,
    JSON.stringify(playback));

  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: 50, y: 30, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: 50, y: 30, button: 'left', clickCount: 1 });
  await sleep(300);
  const activatedPlayback = await wc.executeJavaScript(`(() => {
    const media = document.getElementById('probe');
    return { paused: media.paused, currentTime: media.currentTime, playEvents: window.__playEvents };
  })()`);
  record('K', 'media plays after an explicit user click',
    activatedPlayback.paused === false && activatedPlayback.playEvents > 0,
    JSON.stringify(activatedPlayback));

  /* ---------- Test A (Gates B/C): ad/tracker requests blocked ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/ad_tracking.html`);
  const ad = await wc.executeJavaScript('({ adLoaded: !!window.__adLoaded, gaLoaded: !!window.__gaLoaded, okLoaded: !!window.__okLoaded })');
  record('BLOCKING', 'advertising request blocked (Test A)',
    ad.okLoaded === true && ad.adLoaded === false && ad.gaLoaded === false, JSON.stringify(ad));
  record('SITE-PRIVACY', 'blocked requests attributed to the owning WebContents',
    siteHits.some(x => x.id === wc.id && x.category === 'ADVERTISING'), JSON.stringify(siteHits));

  // Exercise the adapter in real Chromium with a synthetic allowlist and
  // classifier. No site exception is written to the checkout/user profile.
  const privacyPart = PART + '-privacy';
  const privacySession = session.fromPartition(privacyPart);
  const privacyHits = [];
  const privacyAdapter = new SessionAdapter({ session: privacySession,
    engine: { classifyRequest: () => ({ category: 'ADVERTISING', filterDecision: 'block',
      matchedKind: 'hostname', matchedRule: 'fixture', firstParty: false }) },
    log: eventLog, modeId: 'standard', onSiteBlocked: id => privacyHits.push(id) });
  privacyAdapter.install();
  const privacyWin = new BrowserWindow({ show: false, webPreferences: createPageWebPreferences({ partition: privacyPart }) });
  const previousAllowed = allowlist.isAllowed;
  allowlist.isAllowed = host => host === 'localhost';
  try {
    await loadAndWait(privacyWin.webContents, `http://localhost:${p}/privacy-subrequest`);
    const loaded = await privacyWin.webContents.executeJavaScript('window.__privacyLoaded === true');
    record('SITE-PRIVACY', 'referrerless third-party script inherits owning allowlisted page',
      loaded && !privacyHits.includes(privacyWin.webContents.id), JSON.stringify({ loaded, hits: privacyHits }));
    let denied = false;
    try { await privacyWin.webContents.loadURL(`http://127.0.0.1:${p}/clean.html`); }
    catch { denied = true; }
    record('SITE-PRIVACY', 'main-frame destination outside allowlist is blocked after allowed page',
      denied && privacyHits.includes(privacyWin.webContents.id), JSON.stringify({ denied, hits: privacyHits }));
  } finally {
    allowlist.isAllowed = previousAllowed;
    privacyWin.destroy();
  }

  /* ---------- Tests B & C (Gate D): cookies ---------- */
  await loadAndWait(wc, `http://localhost:${p}/cookies.html`);
  const names = (await ses.cookies.get({})).map((c) => c.name);
  record('B', 'first-party cookies (server + JS) allowed',
    names.includes('forge_1p') && names.includes('session_js'), 'jar=' + names.join(','));
  record('C', 'third-party cookie blocked',
    !names.includes('partner'), 'jar=' + names.join(','));

  /* ---------- Origin-only clear in a real shared Chromium session ---------- */
  const otherWin = new BrowserWindow({ show: false, webPreferences: createPageWebPreferences({ partition: PART }) });
  await loadAndWait(otherWin.webContents, `http://127.0.0.1:${p}/clean.html`);
  await wc.executeJavaScript("localStorage.setItem('site-private','alpha')");
  await otherWin.webContents.executeJavaScript("localStorage.setItem('site-private','beta')");
  const live = { wc, id: 1, agentOwned: false };
  const neighbor = { wc: otherWin.webContents, id: 2, agentOwned: false };
  const clearResult = await clearOriginData({ tab: live, current: () => live, tabs: [live, neighbor],
    session: ses, dedicated: false, confirm: async origin => origin === `http://localhost:${p}` });
  await loadAndWait(wc, `http://localhost:${p}/cookies.html`);
  const alphaAfter = await wc.executeJavaScript("localStorage.getItem('site-private')");
  const betaAfter = await otherWin.webContents.executeJavaScript("localStorage.getItem('site-private')");
  const cookieAfter = (await ses.cookies.get({ url: `http://localhost:${p}/` })).some(c => c.name === 'forge_1p');
  record('SITE-PRIVACY', 'real shared session clears only selected origin storage; other origin and cookies survive',
    clearResult.ok && !clearResult.cacheCleared && alphaAfter === null && betaAfter === 'beta' && cookieAfter,
    JSON.stringify({ clearResult, alphaAfter, betaAfter, cookieAfter }));
  otherWin.destroy();

  const dedicatedPart = PART + '-origin-clear';
  const dedicatedSession = session.fromPartition(dedicatedPart);
  const dedicatedWin = new BrowserWindow({ show: false, webPreferences: createPageWebPreferences({ partition: dedicatedPart }) });
  await loadAndWait(dedicatedWin.webContents, `http://localhost:${p}/clean.html`);
  await dedicatedWin.webContents.executeJavaScript("localStorage.setItem('site-private','dedicated'); document.cookie='dedicated_cookie=1; Path=/'");
  const dedicatedTab = { wc: dedicatedWin.webContents, id: 3, agentOwned: false };
  const dedicatedResult = await clearOriginData({ tab: dedicatedTab, current: () => dedicatedTab, tabs: [dedicatedTab],
    session: dedicatedSession, dedicated: true, confirm: async () => true });
  await loadAndWait(dedicatedWin.webContents, `http://localhost:${p}/clean.html`);
  const dedicatedStorage = await dedicatedWin.webContents.executeJavaScript("localStorage.getItem('site-private')");
  const dedicatedCookies = (await dedicatedSession.cookies.get({ url: `http://localhost:${p}/` })).filter(c => c.name === 'dedicated_cookie');
  record('SITE-PRIVACY', 'real dedicated session clears host-only cookie, origin storage and cache',
    dedicatedResult.ok && dedicatedResult.cacheCleared && dedicatedResult.cookiesRemoved === 1 &&
    dedicatedStorage === null && dedicatedCookies.length === 0,
    JSON.stringify({ dedicatedResult, dedicatedStorage, dedicatedCookies: dedicatedCookies.length }));
  dedicatedWin.destroy();

  /* ---------- Test D (Gate E): tracking URL cleanup ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/clean.html?utm_source=test&utm_campaign=e2e&id=10&fbclid=x`);
  const finalUrl = wc.getURL();
  const inPage = await wc.executeJavaScript('window.__finalUrl');
  record('D', 'tracking parameters removed from navigation',
    !/utm_source|fbclid/.test(finalUrl) && /id=10/.test(finalUrl), `final=${finalUrl}`);
  record('D', 'page observed the cleaned URL',
    !/utm_source|fbclid/.test(inPage || ''), `inPage=${inPage}`);

  /* ---------- Sensitive value repeated in literal/encoded URL paths ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/snapshot-duplication/fixturePathValue78/%66%69%78%74%75%72%65%50%61%74%68%56%61%6c%75%65%37%38`);
  const indexedRaw = await wc.executeJavaScript(forgeSnapshotScript(), true);
  const indexedSafe = normalizeSnapshot(indexedRaw);
  const serialized = JSON.stringify({ indexedRaw, indexedSafe });
  record('C1', 'real renderer scrubs sensitive literal/encoded URL and href paths',
    !serialized.includes('fixturePathValue78') &&
      !serialized.toLowerCase().includes('%66%69%78%74%75%72%65%50%61%74%68%56%61%6c%75%65%37%38') &&
      indexedSafe.elements.some(el => el.href && el.href.includes('<REDACTED>')) &&
      indexedSafe.below_fold.some(el => el.href && el.href.includes('<REDACTED>')),
    JSON.stringify({ url: indexedSafe.url, elements: indexedSafe.elements.length, below: indexedSafe.below_fold.length }));

  /* ---------- Associated HTML label and aria-labelledby ---------- */
  await loadAndWait(wc, `http://127.0.0.1:${p}/associated-label/fixtureOnlyLabel76/%66%69%78%74%75%72%65%4f%6e%6c%79%4c%61%62%65%6c%37%36`);
  const associatedRaw = await wc.executeJavaScript(IN_PAGE_SCRIPT, true);
  const associatedView = analyzeAgentView(associatedRaw);
  const associatedSnapshot = normalizeSnapshot(await wc.executeJavaScript(forgeSnapshotScript(), true));
  const associatedBytes = JSON.stringify({ associatedRaw, associatedView, associatedSnapshot });
  record('C1', 'real renderer associated labels redact both ordinary inputs and literal/encoded duplicates',
    associatedRaw.inputs.length === 2 && associatedRaw.inputs.every(input => input.sensitive && input.value === '<REDACTED>') &&
      !associatedBytes.includes('fixtureOnlyLabel76') &&
      !associatedBytes.toLowerCase().includes('%66%69%78%74%75%72%65%4f%6e%6c%79%4c%61%62%65%6c%37%36'),
    JSON.stringify({ inputs: associatedRaw.inputs.map(input => ({ sensitive: input.sensitive, value: input.value })),
      url: associatedView.url }));

  await loadAndWait(wc, `http://127.0.0.1:${p}/editable-sensitive/fixtureEditable74/%66%69%78%74%75%72%65%45%64%69%74%61%62%6c%65%37%34`);
  const editableRaw = await wc.executeJavaScript(IN_PAGE_SCRIPT, true);
  const editableIndexed = normalizeSnapshot(await wc.executeJavaScript(forgeSnapshotScript(), true));
  const editablePayload = JSON.stringify({ editableRaw, editableIndexed, view: analyzeAgentView(editableRaw) });
  record('C1', 'real contenteditable password value redacted across view and indexed snapshot',
    editableRaw.inputs.some(input => input.type === 'contenteditable' && input.sensitive && input.value === '<REDACTED>') &&
    editableRaw.bodyText.includes('Ordinary prose') && !editablePayload.includes('fixtureEditable74') &&
    !editablePayload.toLowerCase().includes('%66%69%78%74%75%72%65%45%64%69%74%61%62%6c%65%37%34'.toLowerCase()),
    JSON.stringify({ inputs: editableRaw.inputs, url: editableIndexed.url }));

  await loadAndWait(wc, `http://127.0.0.1:${p}/approval-display/fixtureDialogPath93?item=fixtureDialogPath93`);
  const displaySnapshot = normalizeSnapshot(await wc.executeJavaScript(forgeSnapshotScript(), true));
  const displayButton = displaySnapshot.elements.find(el => el.role === 'button');
  const inspected = displayButton && await wc.executeJavaScript(
    forgeActionScript(displayButton.index, 'inspect', 'synthetic-e2e-nonce', { kind: 'click' }), true);
  record('C1', 'real renderer excludes sensitive fill candidate and sanitizes approval display, retaining raw proof',
    displaySnapshot.elements.some(el => el.sensitive && el.kind === 'blocked') &&
    Object.keys(candidatesFor(displaySnapshot, 'fill')).length === 0 &&
    inspected && inspected.ok && inspected.descriptor.pageUrl.includes('fixtureDialogPath93') &&
    inspected.descriptor.label.includes('fixtureDialogPath93') &&
    !JSON.stringify(inspected.display).includes('fixtureDialogPath93') &&
    inspected.display.label.includes('<REDACTED>') && inspected.display.pageUrl.includes('<REDACTED>'),
    JSON.stringify({ safeUrl: displaySnapshot.url, display: inspected && inspected.display }));

  /* Private raw effect witness: two query recipients look identical in the
   * agent-visible projection, but must never share an approval. */
  await loadAndWait(wc, `http://127.0.0.1:${p}/clean.html`);
  await wc.executeJavaScript(`document.body.innerHTML =
    '<a id="recipient-link" href="/submit?recipient=alice">Continue</a>'`);
  const privateRaw = await wc.executeJavaScript(forgeSnapshotScript(true), true);
  const privateHashes = new Map(privateRaw._privateEffectProofs.map(([id, proof]) => [id, hashEffectProof(proof)]));
  delete privateRaw._privateEffectProofs;
  const privateSafe = normalizeSnapshot(privateRaw);
  const recipientLink = privateSafe.elements.find(el => el.label === 'Continue');
  const firstInspection = recipientLink && await wc.executeJavaScript(
    forgeActionScript(recipientLink.index, 'inspect', 'fixture-private-first', { kind: 'click' }), true);
  await wc.executeJavaScript(`document.getElementById('recipient-link').href = '/submit?recipient=attacker'`);
  const secondInspection = recipientLink && await wc.executeJavaScript(
    forgeActionScript(recipientLink.index, 'inspect', 'fixture-private-second', { kind: 'click' }), true);
  const before = recipientLink && firstInspection && compareAgentPreview(
    recipientLink, firstInspection, privateSafe.url, 'click', privateHashes.get(recipientLink.index));
  const after = recipientLink && secondInspection && compareAgentPreview(
    recipientLink, secondInspection, privateSafe.url, 'click', privateHashes.get(recipientLink.index));
  record('C1', 'real Chromium snapshot binds raw link query without exposing either recipient to agent',
    recipientLink && firstInspection && secondInspection && before.length === 0 &&
    after.includes('target/effect proof') &&
    firstInspection.display.destination === secondInspection.display.destination &&
    !JSON.stringify(privateSafe).includes('alice') &&
    !JSON.stringify(privateSafe).includes('_privateEffectProofs'),
    JSON.stringify({ before, after, safeHref: recipientLink && recipientLink.href }));

  await loadAndWait(wc, `http://127.0.0.1:${p}/clean.html`);
  await wc.executeJavaScript(`(() => { window.__effectClicks = 0;
    document.body.innerHTML = '<button id="effect" type="button" aria-label="Continue">Original</button>';
    document.getElementById('effect').onclick = () => window.__effectClicks++;
  })()`);
  const effectRaw = await wc.executeJavaScript(forgeSnapshotScript(true), true);
  const effectButton = effectRaw.elements.find(el => el.label === 'Continue');
  const effectProof = effectRaw._privateEffectProofs.find(([id]) => id === effectButton.index)[1];
  const effectHash = hashEffectProof(effectProof);
  const effectInspect = await wc.executeJavaScript(
    forgeActionScript(effectButton.index, 'inspect', 'fixture-effect-nonce', { kind: 'click' }), true);
  await wc.executeJavaScript(`document.getElementById('effect').textContent = 'Changed'`);
  const changedEffect = await wc.executeJavaScript(forgeActionScript(effectButton.index, 'click', null,
    { nonce: 'fixture-effect-nonce', descriptor: effectInspect.descriptor, effectProofHash: effectHash }), true);
  const effectClicks = await wc.executeJavaScript('window.__effectClicks');
  record('C1', 'real Chromium final click atomically refuses changed private effect after inspection',
    changedEffect && !changedEffect.ok && changedEffect.reason === 'approval_required_or_stale' && effectClicks === 0,
    JSON.stringify({ reason: changedEffect && changedEffect.reason, effectClicks }));

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

  await runNotebookE2E(wc, `http://127.0.0.1:${p}/clean.html`, scratchProfile, record);
  await runAgentProxyE2E(record);
  await runQuicE2E(record);

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
  // Chromium may still hold the profile on Windows until the Electron process
  // exits; the test runner cleans its scratch profile after process exit.
  app.exit(failed === 0 ? 0 : 1);
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('E2E CRASH:', e); app.exit(2); });
