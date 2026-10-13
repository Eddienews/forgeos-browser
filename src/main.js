/*
 * main.js — Forge Browser Lab (Phase 1 browser shell + integration).
 *
 * The engine (src/engine/*) is pure and browser-agnostic; this file wires it
 * to Electron and owns the minimal browser UI: tabs (WebContentsView),
 * address bar, back/forward/reload, security indicator, privacy dashboard,
 * agent view panel, action approval gate, downloads, and local history.
 *
 * Security posture (Phase 17): page WebContentsViews run with
 * sandbox:true, contextIsolation:true, nodeIntegration:false, and no preload.
 * The chrome window's own preload exposes only the whitelisted `window.forge`
 * bridge. Untrusted content cannot reach the engine, filesystem, credentials,
 * or other tabs.
 */
'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { FilterEngine } = require('./engine/filter-engine');
const { EventLog } = require('./engine/event-log');
const { SessionAdapter } = require('./ext/electron-adapter');
const { sessionPlanFor, captureTabReloadPlan, clearSessionData, containerPartition, CONTAINER_IDS } = require('./engine/storage-manager');
const { MODES, isValidMode } = require('./engine/privacy-modes');
const { analyzeAgentView, IN_PAGE_SCRIPT, readPageView } = require('./engine/agent-view');
const { applyAppLevelHardening, setEngineBrands } = require('./engine/fingerprint-hardening');
const { requestAction } = require('./engine/permissions');
const settings = require('./engine/settings');
const bh = require('./engine/bookmarks-history');
const allowlist = require('./engine/site-allowlist');
const sitePermissions = require('./engine/site-permissions');
const { startAgentApi } = require('./ext/agent-api');
const { createAgentSession } = require('./engine/agent-network-proxy');
const { forgeSnapshotScript } = require('./page-snapshot');
const { forgeActionScript, forgeScrollScript } = require('./page-actions');
const { normalizeSnapshot } = require('./engine/page-snapshot');
const { classifyAction, compareAgentPreview, hashEffectProof } = require('./engine/action-policy');
const { runGoal } = require('./engine/agent-loop');
const credentialPolicy = require('./engine/credential-policy');
const { browserViewBounds, popupDecision } = require('./engine/view-layout');
const { shortcutAction, nextZoom, tabTarget, externalUrls, closedTabRecord, rememberClosedTab } = require('./engine/desktop-integration');
const sessionStore = require('./engine/session-store');
const notebook = require('./engine/research-notebook');
const { cleanUrlString } = require('./engine/url-cleaner');
const { classifyField } = require('./engine/sensitive-fields');
const { createPageWebPreferences } = require('./page-web-preferences');
const { createDownloads } = require('./main/downloads');
const { createPageInjection } = require('./main/page-injection');
const { createPageOutput } = require('./main/page-output');
const { createSmoke } = require('./main/smoke');
const { createUpdateNotice } = require('./main/update-notice');
const agentProvider = require('./engine/agent-provider');
const { isExistingPathInside, isSafeToOpen } = require('./engine/download-center');
const { pageProcessingPolicy } = require('./engine/page-processing-policy');
const { FindInPage } = require('./engine/find-in-page');
const { siteSnapshot, clearOriginData } = require('./engine/site-privacy');

const TOOLBAR_H = 42; // must match renderer CSS --bar-h
const FIND_H = 42; // must match renderer CSS --find-h
let menuRightInset = 0;
const APP_ROOT = __dirname;
const RENDERER = path.join(APP_ROOT, 'renderer', 'index.html');
// The toolbar and Control Center never share a session with web content: the
// page adapter owns the default session's single webRequest listener slots.
const CHROME_UI_PARTITION = 'forge-chrome-ui';

// Runtime-writable dirs: use app.getPath('userData') when packaged (OS-sanctioned
// config location). A .portable marker file next to the executable overrides to
// keep dirs local to the executable (USB-drive / portable mode).
// Dev (no asar): project root is fine.
const IS_PACKAGED = __dirname.includes('app.asar');
const SMOKE_RUNTIME_BASE = process.argv.includes('--smoke')
  ? process.env.FORGE_SMOKE_RUNTIME_BASE
  : null;

// One browser per profile: two processes writing the same history, session and
// site-data files corrupt them, and the second cannot bind the Agent API. A
// second launch hands its links to the running browser and exits. Smoke runs
// use their own runtime base and must work while a browser is open.
const HAS_INSTANCE_LOCK = !!SMOKE_RUNTIME_BASE || app.requestSingleInstanceLock();
if (!HAS_INSTANCE_LOCK) app.quit();

function getRuntimeBase() {
  if (SMOKE_RUNTIME_BASE) return path.resolve(SMOKE_RUNTIME_BASE);
  if (!IS_PACKAGED) return path.dirname(APP_ROOT);
  const exeDir = path.dirname(process.execPath);
  // Portable mode: .portable marker next to the executable
  if (fs.existsSync(path.join(exeDir, '.portable'))) return exeDir;
  // OS-sanctioned user-data directory (cross-platform safe)
  try { return app.getPath('userData'); } catch { return exeDir; }
}

function getLogFile() {
  return path.join(getRuntimeBase(), 'logs', 'forge-events.log');
}

function getDownloadDir() {
  return path.join(getRuntimeBase(), 'downloads');
}

// Dev checkouts are repositories: never place notebook user data in source.
// Packaged/portable and smoke runs retain their existing runtime base.
function getNotebookBase() {
  return !IS_PACKAGED && !SMOKE_RUNTIME_BASE ? app.getPath('userData') : getRuntimeBase();
}

// Lazy: log is initialized inside app.whenReady() so getRuntimeBase() can use
// app.getPath.  Top-level code before ready uses a no-op fallback.
let log = { log: () => {} }; // no-op until real init
let engine = null;
let agentApi = null;
const LOG_FILE = getLogFile;
const DL_DIR = getDownloadDir;
const RUNTIME_BASE_REF = getRuntimeBase;

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

try {
  // Optional drop-in filter lists (easy list format) — see update-lists.js
  for (const f of ['easylist.txt', 'easyprivacy.txt']) {
    const p = path.join(path.dirname(APP_ROOT), 'lists', f);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      // engine created inside whenReady; filter lists loaded there too
    }
  }
} catch {}

let modeId = 'standard';
let chromeWin = null;
let panelWin = null;
let tabSeq = 0;
const tabs = new Map();   // id -> tab
const sessions = new Map(); // partitionKey -> { session, adapter }
let activeTabId = null;
const pageFind = new FindInPage((status) => {
  layoutActiveView();
  sendToChrome('forge:find-result', status);
});
let agentLease = null;
let agentTabId = null;

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

// `log` is replaced with the real event log once the app is ready, so modules
// receive a stable logger that always forwards to the current one.
const logger = { log: (...args) => log.log(...args) };

// What the modules under src/main/ may use. Values that change over time
// (the window, the active tab) are getters, read live on every use.
const ctx = {
  logger,
  isPackaged: IS_PACKAGED,
  isSmoke: !!SMOKE_RUNTIME_BASE,
  get chromeWin() { return chromeWin; },
  get activeTabId() { return activeTabId; },
  activeTab: () => activeTab(),
  sendToChrome: (channel, payload) => sendToChrome(channel, payload),
  openHumanTab: (url) => openHumanTab(url),
  createTab: (url, opts) => createTab(url, opts),
  switchTab: (id, opts) => switchTab(id, opts),
  refreshAgentView: (tab) => refreshAgentView(tab),
  securityFor: (tab) => securityFor(tab),
  getRuntimeBase: () => getRuntimeBase(),
  getDownloadDir: () => getDownloadDir(),
};

const { downloads, plugins, pushDownload, runPluginJob } = createDownloads(ctx);
const { initCosmetic, injectPageAppearance, injectCosmetic, injectDomRemoval } = createPageInjection(ctx);
const { publicUpdateStatus, runUpdateCheck, scheduleUpdateChecks, openUpdatePage } = createUpdateNotice(ctx);
const { printActiveTab, savePageAsPdf } = createPageOutput(ctx);
const { runSmoke } = createSmoke(ctx);

function persistOpenTabs() {
  try { return sessionStore.captureOpenTabs(tabs, getRuntimeBase()); }
  catch { return 0; }
}

function noteSiteBlock(webContentsId, category) {
  const tab = [...tabs.values()].find(t => t.wc.id === webContentsId);
  if (!tab || !tab.siteCounts) return;
  const key = { ADVERTISING: 'ads', TRACKING: 'trackers', ANALYTICS: 'analytics', THIRD_PARTY: 'thirdParty' }[category];
  if (key) tab.siteCounts[key]++;
}

// Remembered site permissions belong to the human. An agent-owned session
// neither reads nor writes them.
function sitePermissionsFor(partitionKey) {
  return String(partitionKey || '').startsWith('forge-agent-') ? null : sitePermissions;
}

function getSessionFor(partitionKey) {
  if (partitionKey == null) {
    let e = sessions.get('__default__');
    if (!e) {
      const s = session.defaultSession;
      e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, downloadsDir: DL_DIR(), getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r), onSiteBlocked: noteSiteBlock, sitePermissions: sitePermissionsFor(partitionKey) }) };
      sessions.set('__default__', e);
    }
    return e;
  }
  let e = sessions.get(partitionKey);
  if (!e) {
    const s = session.fromPartition(partitionKey);
    e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, downloadsDir: DL_DIR(), getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r), onSiteBlocked: noteSiteBlock, sitePermissions: sitePermissionsFor(partitionKey) }) };
    sessions.set(partitionKey, e);
  }
  return e;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function createTab(url = 'about:blank', opts = {}) {
  const id = ++tabSeq;
  const containerId = opts.agentLease ? null : (opts.containerId || null);
  const plan = opts.agentLease
    ? { partition: opts.agentLease.partition, retainHistory: false, restoreOnRestart: false }
    : sessionPlanFor(url, modeId, !!opts.forgetOnClose, containerId);
  const { session: ses, adapter } = getSessionFor(plan.partition);
  adapter.setMode(modeId);
  adapter.install();

  const view = new WebContentsView({
    webPreferences: createPageWebPreferences({ partition: plan.partition }),
  });
  const wc = view.webContents;
  // Apply the persisted default zoom to every new page view.
  try { wc.setZoomFactor((settings.all().pageZoom || 100) / 100); } catch {}

  const tab = {
    id, view, wc, adapter, partition: plan.partition, containerId,
    agentOwned: !!opts.agentLease,
    url, title: '', history: [], index: -1,
    modeId,
    forgetOnClose: !!opts.forgetOnClose,
    retainHistory: plan.retainHistory,
    restoreOnRestart: plan.restoreOnRestart,
    certError: false,
    pageCounts: { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 },
    siteCounts: { ads: 0, trackers: 0, analytics: 0, thirdParty: 0 },
    blockedCredentialUrl: null,
    blockedCredentialNoticeUrl: null,
    lastAgentView: null,
  };
  tabs.set(id, tab);

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    sendState();
  });

  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      tab.certError = false;
      tab.siteCounts = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0 };
      tab.lastAgentObservation = null;
    }
    if (isMainFrame && pageFind.tab === tab) pageFind.close();
  });
  wc.on('found-in-page', (_e, result) => pageFind.result(tab, result));
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || !input.key) return;
    const ctrl = input.control || input.meta;
    const find = ctrl && !input.alt && input.key.toLowerCase() === 'f';
    const repeat = !ctrl && !input.alt && input.key === 'F3';
    const close = !ctrl && !input.alt && input.key === 'Escape' && pageFind.opened;
    if (!find && !repeat && !close) {
      // Browser shortcuts work while a page has focus; the page never sees them.
      const action = activeTabId === tab.id ? shortcutAction(input) : null;
      if (action) { event.preventDefault(); runShortcut(action); }
      return;
    }
    event.preventDefault();
    if (activeTabId === tab.id) {
      if (close) pageFind.close();
      else sendToChrome('forge:find-shortcut', find ? 'open' : (input.shift ? 'previous' : 'next'));

    }
  });

  wc.on('did-navigate', (_e, url, httpCode) => {
    if (url === tab.blockedCredentialNoticeUrl && tab.blockedCredentialUrl) {
      tab.url = tab.blockedCredentialUrl;
      sendState();
      return;
    }
    tab.blockedCredentialUrl = null;
    tab.blockedCredentialNoticeUrl = null;
    adapter.httpsOnly.settle(url);
    // The blank document is not a visit: no history entry, nothing to inject.
    if (url === 'about:blank') { tab.url = url; sendState(); return; }
    // NO-CREDENTIALS policy: intercept identity-provider sign-in pages and
    // show a clear notice instead of Google's misleading "may not be secure".
    if (credentialPolicy.matchesCredentialHost(url) && !settings.all().allowCredentials) {
      // Per-site opt-in? (user accepted the risk in the badge menu)
      let optedIn = false;
      try { optedIn = settings.all().credentialOptIn?.[new URL(url).hostname.toLowerCase()] === true; } catch {}
      if (!optedIn) {
        const notice = credentialPolicy.NOTICE_HTML(new URL(url).hostname);
        tab.blockedCredentialUrl = url;
        tab.blockedCredentialNoticeUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(notice);
        wc.loadURL(tab.blockedCredentialNoticeUrl);
        tab.url = url; // keep the intended URL in history/state
        log.log('INFO', 'sign-in blocked by no-credentials policy', { host: new URL(url).hostname });
        sendState();
        return;
      }
    }
    tab.url = url;
    // Commit into history (truncate forward entries).
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    tab.pageCounts = adapter.takeDelta();
    log.log('INFO', 'navigated', { url: url.slice(0, 300), httpCode });
    if (tab.retainHistory) bh.addHistory({ url, title: wc.getTitle() });
    injectPageAppearance(tab, url);
    injectCosmetic(tab, url);
    injectDomRemoval(tab, url);
    // Crash recovery: persist open tabs on every navigation so a force-kill
    // or crash at any moment can restore the last good state.
    persistOpenTabs();
    sendState();
  });

  // DOM removal pass: cosmetic CSS hides ad boxes, but testers (turtlecute)
  // score "blocked" only when the element is REMOVED. After the page settles,
  // executeJavaScript removes matched elements entirely. Runs once per
  // navigation; respects blockAds toggle + allowlist via same gate as CSS.
  let domRemovalTimer = null;
  wc.on('did-finish-load', () => {
    if (domRemovalTimer) clearTimeout(domRemovalTimer);
    const url = wc.getURL();
    if (!pageProcessingPolicy(url).allowDomRemoval) return;
    domRemovalTimer = setTimeout(() => injectDomRemoval(tab, wc.getURL()), 1200);
  });

  wc.on('did-navigate-in-page', (_e, url) => {
    tab.url = url;
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    if (tab.retainHistory) bh.addHistory({ url, title: wc.getTitle() });
    persistOpenTabs();
    sendState();
  });

  wc.on('did-finish-load', () => {
    if (!pageProcessingPolicy(wc.getURL()).allowAutomaticAgentView) return;
    refreshAgentView(tab).then(() => sendState()).catch(() => {});
  });

  wc.on('certificate-error', (_e, url, error) => {
    // Never bypass TLS validation (Phase 17 / constraints).
    tab.certError = true;
    log.log('ERROR', 'certificate error (blocked)', { url: url.slice(0, 200), error: String(error).slice(0, 120) });
    sendState();
  });

  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (code === -3) return; // aborted
    log.log('ERROR', 'load failed', { code, desc: String(desc).slice(0, 120), url: String(validatedURL).slice(0, 200) });
    if (isMainFrame) offerHttpFallback(tab, validatedURL, desc);
  });

  wc.on('render-process-gone', (_e, details) => {
    log.log('ERROR', 'renderer gone', { reason: details.reason, exitCode: details.exitCode });
  });

  // No untrusted content opens its own chrome: a native child window is
  // always denied. A human tab's link that asks for a new window (target=_blank,
  // window.open) is reopened as an ordinary ForgeOS tab instead, with no opener
  // relationship, but only right after real user input on that tab. Agent
  // tabs never open tabs.
  let lastUserInputAt = 0;
  wc.on('input-event', (_e, input) => {
    if (input && (input.type === 'mouseDown' || input.type === 'mouseUp' || input.type === 'keyDown' ||
        input.type === 'rawKeyDown' || input.type === 'gestureTap')) lastUserInputAt = Date.now();
  });
  wc.setWindowOpenHandler(({ url }) => {
    const decision = popupDecision({
      url, agentOwned: tab.agentOwned, closing: !!tab.closing, active: activeTabId === tab.id,
      msSinceUserInput: Date.now() - lastUserInputAt, openTabs: tabs.size,
    });
    if (decision.open) {
      lastUserInputAt = 0; // one tab per user action
      log.log('ALLOW', 'link opened in new tab', { url: url.slice(0, 200) });
      // After this handler returns: never create a view inside the callback.
      setImmediate(() => {
        if (tab.closing || !tabs.has(tab.id)) return;
        try {
          const opened = createTab('about:blank', {
            containerId: tab.containerId, forgetOnClose: tab.forgetOnClose && !tab.containerId,
          });
          switchTab(opened.id, { focus: true });
          navigateIn(opened, decision.url);
        } catch (error) {
          log.log('ERROR', 'new tab from link failed', { error: String(error).slice(0, 120) });
        }
      });
    } else {
      log.log('DENY', 'window.open blocked', { url: String(url).slice(0, 200), reason: decision.reason });
    }
    return { action: 'deny' };
  });

  if (tab.agentOwned) {
    // WebRTC's default UDP route does not honor an HTTP session proxy.
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const denyNonWeb = (event, target) => {
      if (!/^https?:\/\//i.test(target)) event.preventDefault();
    };
    wc.on('will-navigate', denyNonWeb);
    wc.on('will-redirect', denyNonWeb);
  }

  // A blank tab still loads a real (network-free) blank document: a view that
  // never loaded anything receives no input events, so keyboard shortcuts
  // would be dead while it has focus.
  wc.loadURL(url && url !== '' ? url : 'about:blank').catch(() => {});
  return tab;
}

/**
 * HTTPS-only fallback. The secure retry of an http:// navigation failed: the
 * site may not support HTTPS, or something on the network is interfering. The
 * browser never downgrades by itself; the human decides, per host, for this
 * session. An agent tab is never offered the downgrade.
 */
async function offerHttpFallback(tab, failedUrl, reason) {
  const upgrade = tab.adapter.httpsOnly.takeFailedUpgrade(failedUrl);
  if (!upgrade) return false;
  if (tab.agentOwned || tab.closing || activeTabId !== tab.id || !chromeWin || chromeWin.isDestroyed()) {
    log.log('DENY', 'insecure fallback not offered', { host: upgrade.host, reason: tab.agentOwned ? 'agent tab' : 'tab not visible' });
    return false;
  }
  const result = await dialog.showMessageBox(chromeWin, {
    type: 'warning',
    title: 'ForgeOS Browser — secure connection unavailable',
    message: `${upgrade.host} could not be opened over HTTPS.`,
    detail: `Reason: ${String(reason || 'connection failed').slice(0, 120)}\n\n` +
      'Over plain HTTP, anyone on the network can read and change what you see and send. ' +
      'Continue only if you do not enter private information.\n\n' +
      'Your choice applies to this site until the browser is closed.',
    buttons: ['Stay secure', 'Continue over HTTP'],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  const allowed = result.response === 1;
  log.log(allowed ? 'ALLOW' : 'DENY', 'insecure HTTP fallback human decision', { host: upgrade.host });
  if (!allowed || tab.closing || tab.wc.isDestroyed() || !tabs.has(tab.id)) return false;
  tab.adapter.httpsOnly.allowHttp(upgrade.host);
  tab.wc.loadURL(upgrade.httpUrl).catch(() => {});
  return true;
}

async function refreshAgentView(tab) {
  try {
    const raw = await Promise.race([
      tab.wc.executeJavaScript(IN_PAGE_SCRIPT, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('extraction timeout')), 8000)),
    ]);
    const av = analyzeAgentView(raw, { trackersBlocked: tab.pageCounts, modeId, timestamp: new Date().toISOString() });
    tab.lastAgentView = av;
    if (av.security.prompt_injection_detected) {
      log.log('WARN', 'possible prompt injection', {
        severity: av.security.prompt_injection_severity,
        url: av.url.slice(0, 300),
        findings: av.security.prompt_injection_findings.length,
      });
    }
    sendToChrome('forge:agent-view', { tabId: tab.id, agentView: av });
    return av;
  } catch (e) {
    // Some pages (devtools, crashes) cannot be extracted; the agent view is
    // still produced with untrusted:true and whatever is known.
    tab.lastAgentView = analyzeAgentView({ url: tab.url, title: tab.title }, { trackersBlocked: tab.pageCounts, modeId });
    sendToChrome('forge:agent-view', { tabId: tab.id, agentView: tab.lastAgentView, error: String(e).slice(0, 120) });
    return tab.lastAgentView;
  }
}

function layoutActiveView() {
  if (!chromeWin || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const { width, height } = chromeWin.getContentBounds();
  tab.view.setBounds(browserViewBounds({
    width, height, toolbarHeight: TOOLBAR_H + (pageFind.opened ? FIND_H : 0), rightInset: menuRightInset,
  }));
  tab.view.setVisible(true);
}

function switchTab(id, { focus = true } = {}) {
  if (activeTabId !== id) pageFind.close();
  const prev = tabs.get(activeTabId);
  if (prev) chromeWin.contentView.removeChildView(prev.view);
  const tab = tabs.get(id);
  if (!tab) return;
  agentNavigationEpoch++;
  activeTabId = id;
  chromeWin.contentView.addChildView(tab.view);
  layoutActiveView();
  if (focus && tab.wc) tab.wc.focus();
  tab.pageCounts = tab.adapter.takeDelta();
  sendState();
}

async function closeTab(id, { notify = true, persist = true } = {}) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (pageFind.tab === tab) pageFind.close();
  if (tab.closePromise) return tab.closePromise;
  // Revoke authority before the first await: an in-flight readiness check
  // cannot load a tab whose teardown has begun.
  tab.closing = true;
  let lease = null;
  if (agentTabId === id) {
    agentNavigationEpoch++;
    agentTabId = null;
    lease = agentLease;
    agentLease = null;
  }
  tab.closePromise = (async () => {
    try {
      if (lease) await lease.stop();
    } finally {
      if (tab.forgetOnClose || tab.modeId === 'ephemeral' || tab.partition && !tab.containerId) {
        try { await clearSessionData(tab.adapter.session); } catch {}
        log.log('INFO', 'site data cleared on tab close', { url: tab.url.slice(0, 200), partition: tab.partition || 'default' });
      }
      chromeWin.contentView.removeChildView(tab.view);
      tab.wc.close();
      tabs.delete(id);
      if (lease) sessions.delete(tab.partition);
      if (activeTabId === id) {
        activeTabId = null;
        const next = [...tabs.keys()].pop();
        if (next != null) switchTab(next, { focus: false });
      }
      if (persist) persistOpenTabs();
      if (notify) sendState();
    }
  })();
  return tab.closePromise;
}

async function changePrivacyMode(nextModeId) {
  if (!isValidMode(nextModeId)) return { ok: false, error: 'invalid privacy mode' };
  if (nextModeId === modeId) return { ok: true, mode: modeId, reloadedTabs: 0 };
  if ([...tabs.values()].some(tab => tab.containerId))
    return { ok: false, error: 'Close named container tabs before changing privacy mode.' };

  const previousModeId = modeId;
  const oldTabs = [...tabs.values()];
  const reloadPlan = captureTabReloadPlan(tabs, activeTabId);
  const replacements = [];
  modeId = nextModeId;
  closedTabs.length = 0; // a mode change must not carry tabs across privacy levels

  try {
    for (const item of reloadPlan.items) {
      replacements.push(createTab(item.url, { forgetOnClose: item.forgetOnClose }));
    }
  } catch (error) {
    for (const tab of replacements) await closeTab(tab.id, { notify: false, persist: false });
    modeId = previousModeId;
    for (const tab of oldTabs) tab.adapter.setMode(tab.modeId);
    sendState();
    log.log('ERROR', 'privacy mode change failed', { from: previousModeId, to: nextModeId, error: String(error).slice(0, 160) });
    return { ok: false, error: 'unable to recreate tabs safely' };
  }

  if (replacements.length) {
    const selected = replacements[reloadPlan.activeIndex >= 0 ? reloadPlan.activeIndex : 0];
    switchTab(selected.id, { focus: false });
  }
  for (const tab of oldTabs) await closeTab(tab.id, { notify: false, persist: false });
  persistOpenTabs();
  log.log('INFO', 'privacy mode changed', {
    from: previousModeId, to: nextModeId, reloadedTabs: replacements.length,
  });
  sendState();
  return { ok: true, mode: modeId, reloadedTabs: replacements.length };
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

const AGENT_RECOVERY = 'Open an agent tab with POST /navigate then POST /navigate/confirm; human tabs cannot be controlled by the agent';
let agentNavigationBusy = false;
let agentNavigationEpoch = 0;
let agentQuitting = false;
function assertAgentNavigationCurrent(tab, lease, epoch) {
  if (agentQuitting || agentNavigationEpoch !== epoch || activeTab() !== tab || tab.closing ||
      tabs.get(tab.id) !== tab || agentTabId !== tab.id || agentLease !== lease ||
      tab.wc.isDestroyed()) throw new Error(AGENT_RECOVERY);
}
async function requireAgentTab() {
  const t = activeTab();
  if (!t || !t.agentOwned || t.id !== agentTabId || !agentLease ||
      t.partition !== agentLease.partition || t.wc.isDestroyed()) throw new Error(AGENT_RECOVERY);
  await agentLease.assertReady();
  if (activeTab() !== t || agentTabId !== t.id) throw new Error(AGENT_RECOVERY);
  if (!/^https?:\/\//i.test(t.wc.getURL())) throw new Error('Agent page must be http(s); ' + AGENT_RECOVERY);
  return t;
}

async function navigateAgent(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Agent destination must be http(s)');
  if (agentNavigationBusy || agentQuitting) throw new Error('Agent navigation in progress or browser quitting');
  agentNavigationBusy = true;
  try {
    if (agentLease && agentTabId && tabs.has(agentTabId)) {
      const t = tabs.get(agentTabId);
      if (activeTab() !== t || t.closing) throw new Error(AGENT_RECOVERY);
      const lease = agentLease, epoch = agentNavigationEpoch;
      try {
        await lease.assertReady();
      } catch (error) {
        assertAgentNavigationCurrent(t, lease, epoch);
        // A failed proxy is not reusable, even for a newly approved navigation.
        await closeTab(t.id);
      }
      if (agentLease) {
        assertAgentNavigationCurrent(t, lease, epoch);
        await t.wc.loadURL(url);
        return;
      }
    } else if (agentLease || agentTabId || [...tabs.values()].some(t => t.agentOwned)) {
      // Never create a second lease while an inconsistent/closing agent tab exists.
      throw new Error(AGENT_RECOVERY);
    }
    const selected = activeTab(), epoch = agentNavigationEpoch;
    const lease = await createAgentSession({ session });
    let t;
    try {
      if (agentQuitting || agentNavigationEpoch !== epoch || activeTab() !== selected || selected?.closing)
        throw new Error(AGENT_RECOVERY);
      // The first network load happens only after setProxy and resolveProxy.
      t = createTab('about:blank', { agentLease: lease });
      agentLease = lease;
      agentTabId = t.id;
      switchTab(t.id, { focus: false });
      const switchedEpoch = agentNavigationEpoch;
      await lease.assertReady();
      assertAgentNavigationCurrent(t, lease, switchedEpoch);
      await t.wc.loadURL(url);
    } catch (error) {
      if (t) await closeTab(t.id);
      else await lease.stop();
      throw error;
    }
  } finally {
    agentNavigationBusy = false;
  }
}

async function approveAgentNavigation(url) {
  if (!chromeWin || chromeWin.isDestroyed()) {
    log.log('DENY', 'agent navigation approval unavailable', { reason: 'no browser window' });
    return false;
  }
  const result = await dialog.showMessageBox(chromeWin, {
    type: 'warning',
    title: 'ForgeOS Browser — agent navigation request',
    message: 'An external agent wants to navigate an isolated agent-owned tab.',
    detail: `Destination:\n${String(url).slice(0, 1000)}\n\nAllow only if you requested this navigation.`,
    buttons: ['Deny', 'Allow navigation'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const allowed = result.response === 1;
  log.log(allowed ? 'ALLOW' : 'DENY', 'agent navigation human decision', {
    url: String(url).slice(0, 300), decision: allowed ? 'allow' : 'deny',
  });
  return allowed;
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts and links from other applications                */
/* ------------------------------------------------------------------ */

// Tabs the human closed, most recent first, for Ctrl+Shift+T. In memory only.
const closedTabs = [];

/** A deliberate close by the human: remember it, then close. */
function closeTabByUser(id) {
  rememberClosedTab(closedTabs, closedTabRecord(tabs.get(id)));
  return closeTab(id);
}

function reopenClosedTab() {
  const record = closedTabs.shift();
  if (!record) return false;
  // A container tab returns to its container; that needs Standard mode.
  const containerId = record.containerId && CONTAINER_IDS.includes(record.containerId) && modeId === 'standard'
    ? record.containerId : null;
  if (record.containerId && !containerId) return reopenClosedTab(); // cannot be restored faithfully: skip it
  const t = createTab('about:blank', { containerId });
  switchTab(t.id, { focus: true });
  navigateIn(t, record.url);
  log.log('INFO', 'closed tab reopened', { url: record.url.slice(0, 200) });
  return true;
}

function focusAddressBar() {
  if (!chromeWin || chromeWin.isDestroyed()) return;
  chromeWin.webContents.focus();
  sendToChrome('forge:focus-address');
}

function openHumanTab(url) {
  const t = createTab('about:blank');
  switchTab(t.id, { focus: !!url });
  if (url) navigateIn(t, url);
  else focusAddressBar();
  return t;
}

/** Run one action from desktop-integration.shortcutAction. Human input only. */
function runShortcut(action) {
  if (!chromeWin || chromeWin.isDestroyed()) return false;
  const t = activeTab();
  switch (action) {
    case 'new-tab': openHumanTab(null); return true;
    case 'close-tab': {
      if (!t) return false;
      const last = tabs.size === 1;
      closeTabByUser(t.id).then(() => { if (last && !agentQuitting && chromeWin && !chromeWin.isDestroyed()) openHumanTab(null); })
        .catch(() => {});
      return true;
    }
    case 'reopen-tab': return reopenClosedTab();
    case 'print': return printActiveTab();
    case 'focus-address': focusAddressBar(); return true;
    case 'reload': if (t) t.wc.reload(); return !!t;
    case 'back':
      if (!t || t.index <= 0) return false;
      t.index -= 1; t.wc.goBack(); return true;
    case 'forward':
      if (!t || t.index >= t.history.length - 1) return false;
      t.index += 1; t.wc.goForward(); return true;
    case 'zoom-in': case 'zoom-out': case 'zoom-reset': {
      const zoom = nextZoom(settings.all().pageZoom, action);
      settings.save({ pageZoom: zoom });
      if (t) t.wc.setZoomFactor(zoom / 100);
      return true;
    }
    case 'fullscreen': chromeWin.setFullScreen(!chromeWin.isFullScreen()); return true;
    case 'devtools': if (t) t.wc.openDevTools({ mode: 'detach' }); return !!t;
    case 'quit': app.quit(); return true;
    default: {
      const target = tabTarget(action, [...tabs.keys()], activeTabId);
      if (target == null || !tabs.has(target)) return false;
      if (target !== activeTabId) switchTab(target);
      return true;
    }
  }
}

/** Open links another application handed over, as ordinary human tabs. */
function openExternalUrls(urls) {
  if (!chromeWin || chromeWin.isDestroyed()) return 0;
  for (const url of urls) {
    log.log('INFO', 'link opened from another application', { url: url.slice(0, 200) });
    openHumanTab(url);
  }
  if (chromeWin.isMinimized()) chromeWin.restore();
  chromeWin.show();
  chromeWin.focus();
  return urls.length;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function normalizeInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^(https?|file):\/\//i.test(s)) return s;
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+([:/?#].*)?$/.test(s)) return 'https://' + s;
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(s);
}

function navigateIn(tab, input) {
  const target = normalizeInput(input);
  if (!target) return null;
  const cleaned = cleanUrlString(target);
  if (cleaned !== target) {
    log.log('CLEAN', 'tracking parameter removed before navigation', { from: target.slice(0, 200), to: cleaned.slice(0, 200) });
  }
  tab.wc.loadURL(cleaned).catch((e) => log.log('ERROR', 'loadURL failed', { error: String(e).slice(0, 120) }));
  return cleaned;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function sendToChrome(channel, payload) {
  const targets = [chromeWin, panelWin].filter((w) => w && !w.isDestroyed());
  for (const w of targets) w.webContents.send(channel, payload);
}

/** Phase 14/17 control-center window: privacy, agent view, log, downloads. */
function togglePanels(section = null) {
  if (panelWin && !panelWin.isDestroyed()) {
    if (section) {
      panelWin.show();
      panelWin.focus();
      panelWin.webContents.send('forge:panel-section', section);
      return;
    }
    panelWin.close();
    panelWin = null;
    return;
  }
  panelWin = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Forge — Control Center',
    backgroundColor: '#14110d',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      partition: CHROME_UI_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWin.loadFile(path.join(APP_ROOT, 'renderer', 'panels.html'));
  if (section) {
    panelWin.webContents.once('did-finish-load', () => {
      if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('forge:panel-section', section);
    });
  }
  panelWin.on('closed', () => { panelWin = null; });
  panelWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sendState();
}

function securityFor(tab) {
  const url = tab.url || '';
  if (!url || url === 'about:blank') return { label: 'BLANK', ok: true };
  if (url.startsWith('file:')) return { label: 'LOCAL', ok: true };
  if (url.startsWith('https:')) return tab.certError ? { label: 'CERT ERROR', ok: false } : { label: 'HTTPS', ok: true };
  if (url.startsWith('http:')) return { label: 'NOT SECURE', ok: false };
  return { label: 'OTHER', ok: true };
}

function buildState() {
  const perTab = [];
  for (const t of tabs.values()) {
    perTab.push({
      id: t.id, url: t.url, title: t.title,
      canGoBack: t.index > 0, canGoForward: t.index < t.history.length - 1,
      security: securityFor(t), counts: t.pageCounts, forget: t.forgetOnClose,
      containerId: t.containerId,
    });
  }
  const totals = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 };
  for (const t of tabs.values()) {
    const c = t.pageCounts;
    for (const k of Object.keys(totals)) totals[k] += c[k] || 0;
  }
  // Live session-wide counters from the shared adapter (for the ⚙ menu).
  let session = null;
  if (activeTabId && tabs.get(activeTabId)) {
    session = tabs.get(activeTabId).adapter.sessionTotals();
  }
  return {
    mode: modeId,
    modeSummary: MODES[modeId].summary,
    activeTabId,
    session,
    tabs: perTab,
    totals,
    downloads: downloads.slice(0, 20),
    recentLogs: log.recent(100),
    audit: typeof log.health === 'function' ? log.health() : {
      enabled: false, healthy: false, bytes: 0, maxBytes: 0, rotated: false,
    },
    privacyDefaults: require('./engine/fingerprint').PERMISSION_DEFAULTS,
  };
}

function sendState() { sendToChrome('forge:state', buildState()); }

// Deliberate chrome action only. The page receives no notebook bridge and the
// selected text never enters an agent snapshot, model request, or event log.
function humanNotebookTab() {
  const t = activeTab();
  if (!t || t.agentOwned || t.closing || t.modeId === 'ephemeral' || t.forgetOnClose ||
      t.restoreOnRestart === false || !t.wc || t.wc.isDestroyed()) throw new Error('Notebook requires a persistent human tab');
  notebook.canonicalUrl(t.wc.getURL());
  return t;
}

function registerIpc() {
  // Every channel is chrome-only. Page views have no preload, so a message
  // from anywhere but the main frame of the toolbar or Control Center window
  // is forged; refuse it before the handler sees its arguments.
  const trustedSender = (event) => [chromeWin, panelWin].some((w) => w && !w.isDestroyed() &&
    event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame);
  const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) {
      log.log('DENY', 'ipc from untrusted sender refused', { channel });
      throw new Error('ForgeOS IPC is chrome-only');
    }
    return listener(event, ...args);
  });
  // Only the trusted toolbar renderer may drive search. Untrusted page views
  // have no preload, and a forged IPC message from a page is rejected too.
  const isChrome = (event) => !!chromeWin && !chromeWin.isDestroyed() &&
    event.sender === chromeWin.webContents &&
    event.senderFrame === chromeWin.webContents.mainFrame;
  handle('forge:find-open', (event) => isChrome(event) && pageFind.open(activeTab()));
  handle('forge:find-search', (event, query, direction) =>
    isChrome(event) && pageFind.search(activeTab(), query, direction));
  handle('forge:find-close', (event) => {
    if (!isChrome(event)) return false;
    pageFind.close();
    return true;
  });
  const fromChrome = e => {
    if (![chromeWin, panelWin].some(w => w && !w.isDestroyed() &&
      e.sender === w.webContents && e.senderFrame === w.webContents.mainFrame))
      throw new Error('Notebook is chrome-only');
  };
  handle('forge:notebook-list', e => { fromChrome(e); return notebook.load(getNotebookBase()); });
  handle('forge:notebook-capture', async e => {
    fromChrome(e);
    const t = humanNotebookTab();
    const id = t.id, url = t.wc.getURL();
    const selection = await t.wc.executeJavaScript(notebook.SELECTION_SCRIPT, true);
    if (activeTabId !== id || t.closing || t.wc.isDestroyed() || t.wc.getURL() !== url ||
        !selection || selection.url !== url) throw new Error('No safe selected excerpt on active human page');
    return notebook.addSource(getNotebookBase(), selection);
  });
  handle('forge:notebook-notes', (e, notes) => { fromChrome(e); return notebook.saveNotes(getNotebookBase(), notes); });
  handle('forge:notebook-compare', (e, ids) => { fromChrome(e); return notebook.setComparison(getNotebookBase(), ids); });
  handle('forge:notebook-remove', (e, id) => { fromChrome(e); return notebook.removeSource(getNotebookBase(), id); });
  handle('forge:notebook-export', async e => {
    fromChrome(e);
    const choice = await dialog.showSaveDialog(panelWin && !panelWin.isDestroyed() ? panelWin : chromeWin, {
      title: 'Export local research notebook',
      defaultPath: path.join(app.getPath('documents'), 'forge-research-notebook.txt'),
      filters: [{ name: 'Plain text', extensions: ['txt'] }],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    if (path.extname(choice.filePath).toLowerCase() !== '.txt') throw new Error('Export requires a .txt destination');
    return notebook.exportTo(getNotebookBase(), choice.filePath);
  });
  handle('forge:navigate', (_e, url) => {
    const t = activeTab();
    if (!t) return null;
    if (t.agentOwned) {
      // A human address-bar load never inherits the agent's proxy or authority.
      const human = createTab('about:blank');
      switchTab(human.id);
      return navigateIn(human, url);
    }
    return navigateIn(t, url);
  });
  handle('forge:back', () => {
    const t = activeTab();
    if (!t || t.index <= 0) return false;
    t.index -= 1;
    t.wc.goBack();
    return true;
  });
  handle('forge:forward', () => {
    const t = activeTab();
    if (!t || t.index >= t.history.length - 1) return false;
    t.index += 1;
    t.wc.goForward();
    return true;
  });
  handle('forge:reload', () => {
    const t = activeTab();
    if (!t) return false;
    t.wc.reload();
    return true;
  });
  handle('forge:new-tab', (_e, url, containerId) => {
    if (containerId != null && (!CONTAINER_IDS.includes(containerId) || modeId !== 'standard')) {
      return { error: 'Containers are available only in Standard mode.' };
    }
    // A named container always starts blank. It cannot silently receive a
    // caller-controlled URL or inherit an existing page's browser context.
    const t = createTab(containerId ? 'about:blank' : url || 'about:blank', { containerId });
    switchTab(t.id, { focus: true });
    return { id: t.id, containerId: t.containerId };
  });
  handle('forge:close-tab', (_e, id) => closeTabByUser(id));
  handle('forge:switch-tab', (_e, id) => { if (tabs.has(id)) switchTab(id); });
  handle('forge:set-menu-open', (_e, state) => {
    if (!chromeWin || !activeTabId) return false;
    const open = typeof state === 'object' ? !!state.open : !!state;
    menuRightInset = open ? Math.max(0, Number(state && state.rightInset) || 0) : 0;
    layoutActiveView();
    return true;
  });
  handle('forge:set-mode', (_e, m) => changePrivacyMode(m));
  handle('forge:toggle-panel', (_e, section) => {
    togglePanels(section === 'downloads' ? 'downloads' : null);
    return true;
  });
  handle('forge:clear-session', async () => {
    log.log('INFO', 'clear session requested');
    const todo = new Set(sessions.values());
    for (const id of CONTAINER_IDS) todo.add(getSessionFor(containerPartition(id)));
    let removed = 0;
    for (const { session: s, adapter } of todo) {
      removed += await clearSessionData(s);
      adapter.clearPermissionGrants();
      adapter.httpsOnly.clear();
    }
    for (const t of tabs.values()) {
      t.history = []; t.index = -1; t.lastAgentView = null;
      t.pageCounts = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 };
      t.adapter.resetCounters();
      t.adapter.takeDelta();
    }
    downloads.length = 0;
    closedTabs.length = 0;
    bh.clearHistory();
    sessionStore.clear(getRuntimeBase());
    log.log('INFO', 'clear session complete', { cookiesRemoved: removed });
    sendState();
    return true;
  });
  handle('forge:set-forget', (_e, on) => {
    const t = activeTab();
    if (!t) return false;
    if (t.containerId) return false; // never wipe a shared named container on one tab close
    t.forgetOnClose = !!on;
    t.restoreOnRestart = t.retainHistory && !t.forgetOnClose;
    persistOpenTabs();
    log.log('INFO', 'forget-on-close ' + (on ? 'enabled' : 'disabled'), { url: t.url.slice(0, 200) });
    sendState();
    return true;
  });
  handle('forge:open-devtools', (_e, id) => {
    const t = tabs.get(id) || activeTab();
    if (t) t.wc.openDevTools({ mode: 'detach' });
  });
  handle('forge:agent-view', () => activeTab()?.lastAgentView || null);
  handle('forge:read-page', () => readPageView(activeTab()?.lastAgentView || null));
  handle('forge:get-links', () => (activeTab()?.lastAgentView?.content.links) || []);
  handle('forge:security-status', () => {
    const t = activeTab();
    return t ? { url: t.url, security: securityFor(t), counts: t.pageCounts, injection: t.lastAgentView?.security || null, mode: modeId } : null;
  });
  const humanSite = (event) => {
    if (!chromeWin || chromeWin.isDestroyed() || event.sender !== chromeWin.webContents) return null;
    const tab = activeTab();
    return tab && siteSnapshot(tab, () => false, () => false, {}) ? tab : null;
  };
  const siteStatus = (event) => {
    const tab = humanSite(event);
    if (!tab) return null;
    const info = siteSnapshot(tab, allowlist.isAllowed,
      h => settings.all().credentialOptIn?.[h] === true, tab.adapter.counters);
    return info && { ...info, credentialsGloballyAllowed: settings.all().allowCredentials === true,
      // Strict and Ephemeral deny these permissions outright; remembered
      // decisions are shown but only take effect in Standard mode.
      permissions: sitePermissions.list(info.origin), permissionsActive: modeId === 'standard' };
  };
  handle('forge:site-privacy', siteStatus);
  handle('forge:site-exception', async (event, kind, enabled) => {
    const tab = humanSite(event), status = siteStatus(event);
    if (!tab || !status || typeof enabled !== 'boolean' || !['blocking', 'credentials'].includes(kind))
      return { ok: false, reason: 'No active human HTTP(S) site or invalid action.' };
    if (enabled) {
      const response = await dialog.showMessageBox(chromeWin, { type: 'warning',
        title: 'Site privacy exception', message: `Allow ${kind === 'blocking' ? 'unfiltered requests' : 'sign-in'} on ${status.host}?`,
        detail: `${status.origin}\nThis weakens protection and can be reversed from this badge.`,
        buttons: ['Cancel', 'Allow on this host'], defaultId: 0, cancelId: 0, noLink: true });
      if (response.response !== 1) return { ok: false, reason: 'Cancelled.' };
    }
    if (humanSite(event) !== tab || siteStatus(event)?.origin !== status.origin)
      return { ok: false, reason: 'Active human site changed.' };
    const host = status.host;
    if (kind === 'blocking') {
      const result = enabled ? allowlist.addExact(host) : allowlist.removeExact(host);
      if (!result.ok) return result;
    } else {
      const map = { ...(settings.all().credentialOptIn || {}) };
      if (enabled) map[host] = true;
      else delete map[host];
      const saved = settings.save({ credentialOptIn: map });
      if (!saved.ok) return { ok: false, reason: 'Unable to save credential exception.' };
    }
    log.log('INFO', 'site exception changed', { host, kind, enabled });
    if (kind === 'credentials' && enabled && tab.blockedCredentialNoticeUrl &&
        tab.wc.getURL() === tab.blockedCredentialNoticeUrl && tab.blockedCredentialUrl) {
      tab.wc.loadURL(tab.blockedCredentialUrl).catch(() => {});
    }
    sendState();
    return { ok: true, site: siteStatus(event) };
  });
  handle('forge:site-permission', async (event, permission, state) => {
    const tab = humanSite(event), status = siteStatus(event);
    if (!tab || !status || !sitePermissions.isManaged(permission) || !['ask', 'allow', 'deny'].includes(state))
      return { ok: false, reason: 'No active human HTTP(S) site or invalid permission.' };
    if (state === 'allow') {
      const label = sitePermissions.MANAGED_PERMISSIONS[permission];
      const response = await dialog.showMessageBox(chromeWin, { type: 'warning',
        title: 'Site permission', message: `Always allow “${label}” on ${status.host}?`,
        detail: `${status.origin}\nThis site will get this capability without asking again. It can be reversed from this badge.`,
        buttons: ['Cancel', 'Always allow'], defaultId: 0, cancelId: 0, noLink: true });
      if (response.response !== 1) return { ok: false, reason: 'Cancelled.' };
    }
    if (humanSite(event) !== tab || siteStatus(event)?.origin !== status.origin)
      return { ok: false, reason: 'Active human site changed.' };
    const result = sitePermissions.set(status.origin, permission, state);
    if (!result.ok) return result;
    // Resetting or blocking also withdraws an approval given earlier in this session.
    if (state !== 'allow') tab.adapter.revokePermissionGrant(status.origin, permission);
    log.log('INFO', 'site permission changed', { host: status.host, permission, state });
    return { ok: true, site: siteStatus(event) };
  });
  handle('forge:site-clear', async (event) => {
    const tab = humanSite(event), status = siteStatus(event);
    if (!tab || !status) return { ok: false, reason: 'No active human HTTP(S) site.' };
    const result = await clearOriginData({ tab, current: activeTab, tabs: [...tabs.values()],
      session: tab.wc.session, dedicated: tab.partition != null && !tab.containerId,
      confirm: async origin => {
        if (!chromeWin || chromeWin.isDestroyed()) return false;
        const response = await dialog.showMessageBox(chromeWin, { type: 'warning',
          title: 'Clear data for this origin?', message: `Clear site data for ${origin}?`,
          detail: 'This cannot be undone. In the shared session, cookies and cache are preserved because deleting them may affect other origins. Domain cookies are always preserved.',
          buttons: ['Cancel', 'Clear this origin'], defaultId: 0, cancelId: 0, noLink: true });
        return response.response === 1;
      } });
    log.log(result.ok ? 'INFO' : 'DENY', 'site origin clear', { origin: status.origin, ok: result.ok });
    return result;
  });
  handle('forge:get-state', () => buildState());
  handle('forge:click', async (_e, selector) => {
    const t = activeTab();
    if (!t || !selector) return { verdict: 'DENY', reason: 'no active tab or selector' };
    try {
      const probe = await t.wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, type: el.type || '', formAction: el.getAttribute('formaction') || '', name: el.name || '', id: el.id || '' };
      })()`, true);
      if (!probe) return { verdict: 'DENY', reason: 'selector not found' };
      const fieldSensitive = classifyField({ type: probe.type, name: probe.name, id: probe.id }).sensitive;
      const gate = await approveAction('CLICK_ELEMENT', { selector, tag: probe.tag, type: probe.type, formAction: probe.formAction, fieldSensitive, url: t.url });
      if (gate.verdict !== 'ALLOW') return gate;
      // This demo acts on the human's own page, outside the isolated agent
      // tab, so even a click the policy allows is confirmed by the human.
      if (!chromeWin || chromeWin.isDestroyed()) return { verdict: 'DENY', reason: 'no browser window to confirm' };
      const confirmation = await dialog.showMessageBox(chromeWin, {
        type: 'question', title: 'ForgeOS Browser — demo click',
        message: 'Click this element on the current page?',
        detail: `Element: ${String(selector).slice(0, 200)}\nPage: ${String(t.url).slice(0, 200)}`,
        buttons: ['Cancel', 'Click'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1 || activeTab() !== t || t.wc.isDestroyed())
        return { verdict: 'DENY', reason: 'click not confirmed by the human' };
      t.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
      t.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
      log.log('ALLOW', 'agent click dispatched', { selector, url: t.url.slice(0, 200) });
      return { verdict: 'ALLOW', reason: 'click dispatched', at: probe };
    } catch (e) {
      return { verdict: 'DENY', reason: 'click failed: ' + String(e).slice(0, 120) };
    }
  });
  handle('forge:request-action', (_e, action, details) => approveAction(action, details || {}));

  // Plugins (⬇ video / ✎ transcript): URL comes from the ACTIVE tab only;
  // the action passes the permission gate before yt-dlp ever starts.
  handle('forge:plugin', (_e, kind) => {
    if (kind !== 'video' && kind !== 'transcript') {
      return { state: 'error', error: 'Unsupported plugin action.' };
    }
    const t = activeTab();
    if (!t || !t.url || !/^https?:/i.test(t.url)) {
      return { state: 'error', error: 'Open a video page first.' };
    }
    return runPluginJob(kind, t.url, t.title);
  });
  handle('forge:plugin-cancel', (_e, jobId) => plugins.cancel(jobId));
  handle('forge:download-cancel', (_e, id) => {
    if (plugins.cancel(id)) return true;
    for (const entry of sessions.values()) {
      if (entry.adapter.cancelDownload(id)) return true;
    }
    return false;
  });
  handle('forge:download-retry', (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || record.kind !== 'plugin' || !record.retryable || !record.url) {
      return { state: 'error', error: 'This download cannot be retried.' };
    }
    return runPluginJob(record.pluginKind, record.url, record.filename);
  });
  handle('forge:download-open', async (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || record.executable || !isSafeToOpen(record.path) ||
        !isExistingPathInside(DL_DIR(), record.path)) return false;
    const error = await shell.openPath(record.path);
    return !error;
  });
  handle('forge:download-reveal', (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || !isExistingPathInside(DL_DIR(), record.path)) return false;
    shell.showItemInFolder(record.path);
    return true;
  });
  // Settings: load all / patch subset; the adapter reads them live per request.
  handle('forge:settings-get', () => settings.all());
  handle('forge:settings-set', (_e, patch) => {
    // Credential exceptions are only changed by the active-human-site IPC.
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.hasOwn(patch, 'credentialOptIn') || Object.hasOwn(patch, 'allowCredentials'))
      return { ok: false, error: 'Credential policy requires the site approval flow.' };
    const res = settings.save(patch);
    if (res.ok) log.log('INFO', 'settings updated', { keys: Object.keys(patch || {}).join(',') });
    return res;
  });
  handle('forge:update-status', () => publicUpdateStatus());
  handle('forge:update-check', () => runUpdateCheck({ manual: true }));
  handle('forge:update-open', () => openUpdatePage());
  handle('forge:print', () => printActiveTab());
  handle('forge:save-pdf', () => savePageAsPdf());
  handle('forge:version', () => app.getVersion());
  /* ---- agent inference key (v0.11): the user's own, never the project's ----
   * The key is written to its own 0600 file, never to settings.json, and it is
   * never logged or echoed back: the renderer only ever learns whether one
   * exists and a masked hint. */
  handle('forge:agent-key-status', () => agentProvider.status(getRuntimeBase()));
  handle('forge:agent-key-set', (_e, payload) => {
    const provider = (payload && payload.provider) || 'typesafe';
    const result = agentProvider.saveKey(getRuntimeBase(), provider, payload && payload.key);
    // Note what happened, never what was written.
    if (result.ok) log.log('INFO', 'agent inference key stored', { provider, hint: result.hint });
    else log.log('DENY', 'agent inference key rejected', { provider, reason: String(result.reason || '').slice(0, 120) });
    return result;
  });
  handle('forge:agent-key-clear', () => {
    const result = agentProvider.clearKey(getRuntimeBase());
    if (result.ok) log.log('INFO', 'agent inference key removed', { removed: !!result.removed });
    return result;
  });
  handle('forge:ytdlp-status', () => {
    // Path inspection only: opening the menu must never launch an external
    // process. Actual tools start only after the plugin approval dialog.
    return require('./ext/plugins').toolchainStatus();
  });

  /* ---- per-site allowlist + zoom (v0.3) ---- */
  handle('forge:presets-list', () => ({
    available: Object.entries(allowlist.TRUST_PRESETS).map(([name, hosts]) => ({ name, hosts: hosts.length })),
    active: allowlist.activePresets(),
  }));
  handle('forge:preset-apply', (_e, name) => {
    const r = allowlist.applyPreset(String(name || ''));
    if (r.ok) { sendState(); log.log('INFO', 'trust preset applied', { preset: name, added: r.addedCount }); }
    return r;
  });
  handle('forge:preset-revoke', (_e, name) => {
    const r = allowlist.revokePreset(String(name || ''));
    if (r.ok) { sendState(); log.log('INFO', 'trust preset revoked', { preset: name, revoked: r.revokedCount }); }
    return r;
  });
  handle('forge:set-zoom', (_e, pct) => {
    const z = Math.max(50, Math.min(200, Number(pct) || 100));
    settings.save({ pageZoom: z });
    const t = activeTab();
    if (t) t.wc.setZoomFactor(z / 100);
    log.log('INFO', 'zoom set', { pct: z });
    return true;
  });

  /* ---- bookmarks & history (local-first, v0.2) ---- */
  handle('forge:bm-list', () => bh.listBookmarks());
  handle('forge:bm-add', (_e, item) => {
    const r = bh.addBookmark(item || {});
    log.log(r.ok && !r.duplicate ? 'INFO' : 'ALLOW', 'bookmark added', { url: String(item?.url || '').slice(0, 200) });
    return r;
  });
  handle('forge:bm-remove', (_e, id) => bh.removeBookmark(id));
  handle('forge:bm-is', (_e, url) => ({ bookmarked: bh.isBookmarked(url) }));
  handle('forge:hist-list', () => bh.listHistory());
  handle('forge:hist-remove', (_e, id) => bh.removeFromHistory(id));
  handle('forge:hist-clear', () => bh.clearHistory());
  // 📁 open the laboratory downloads folder in the OS file manager
  handle('forge:open-downloads', async () => {
    const dlDir = DL_DIR();
    fs.mkdirSync(dlDir, { recursive: true });
    log.log('INFO', 'open downloads folder');
    const err = await shell.openPath(dlDir);
    if (err) log.log('ERROR', 'open downloads failed', { error: String(err).slice(0, 120) });
    return !err;
  });
}

/** Phase 11 approval gate with a human ASK dialog (native, deterministic). */
async function approveAction(action, details) {
  const gate = requestAction(action, details, { pageUrl: activeTab()?.url || '', modeId });
  log.log(gate.verdict, 'agent requested action', { action, verdict: gate.verdict, reason: gate.reason, page: (activeTab()?.url || '').slice(0, 200) });
  if (gate.verdict !== 'ASK') return gate;
  if (chromeWin) {
    const r = await dialog.showMessageBox(chromeWin, {
      type: 'question',
      title: 'Forge Browser Lab — approval required',
      message: `An agent wants to: ${action}`,
      detail: `${gate.reason}${details && details.url ? '\nTarget: ' + String(details.url).slice(0, 200) : ''}`,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const approved = r.response === 1 && !r.checkboxChecked;
    log.log(approved ? 'ALLOW' : 'DENY', 'approval ' + (approved ? 'granted' : 'denied'), { action });
    return { ...gate, humanApproved: approved, reason: approved ? 'approved by human' : gate.reason };
  }
  return { ...gate, humanApproved: false };
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

function createChromeWindow() {
  const winOpts = {
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'ForgeOS Browser',
    backgroundColor: '#14110d',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      partition: CHROME_UI_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  if (process.platform === 'win32') {
    // Compact top with native overlay for min/max/close buttons.
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = {
      color: '#1c1813',
      symbolColor: '#9a8f7d',
      height: 42,
    };
  } else if (process.platform === 'darwin') {
    // macOS: default traffic lights (no overlay needed).
    winOpts.titleBarStyle = 'hiddenInset';
  } else {
    // Linux: hidden title bar, no overlay (window buttons handled by WM).
    winOpts.titleBarStyle = 'hidden';
  }

  // Linux and Windows take the window icon from here; macOS uses the bundle's.
  if (process.platform !== 'darwin') winOpts.icon = path.join(APP_ROOT, '..', 'assets', 'icon.png');

  chromeWin = new BrowserWindow(winOpts);
  chromeWin.setMenuBarVisibility(false);
  // The same shortcuts while the toolbar or address bar has focus. Find keys
  // are handled by the toolbar renderer itself.
  chromeWin.webContents.on('before-input-event', (event, input) => {
    const action = shortcutAction(input);
    if (action) { event.preventDefault(); runShortcut(action); }
  });
  // Debug: forward renderer console to the event log when FORGE_DEBUG_CONSOLE=1.
  if (process.env.FORGE_DEBUG_CONSOLE) {
    chromeWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (String(message).includes('Security Warning')) return;
      log.log(level >= 3 ? 'ERROR' : 'INFO', 'renderer console', { line, source: String(sourceId).split('/').pop(), msg: String(message).slice(0, 200) });
    });
  }
  chromeWin.on('resize', layoutActiveView);
  chromeWin.on('closed', () => { chromeWin = null; });
  // Attach the loader handler BEFORE loadFile: file:// may finish loading
  // near-instantly, so the listener must exist before the request starts.
  chromeWin.webContents.once('did-finish-load', async () => {
    // Learn the engine's client-hint brands from this trusted renderer before
    // any page loads, so request headers repeat what pages read in JavaScript.
    try {
      const reported = await Promise.race([
        chromeWin.webContents.executeJavaScript(`navigator.userAgentData
          ? navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then((v) => ({
              brands: navigator.userAgentData.brands.map((b) => ({ brand: b.brand, version: b.version })),
              fullVersionList: (v.fullVersionList || []).map((b) => ({ brand: b.brand, version: b.version })),
            }))
          : null`),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      log.log('INFO', 'engine client-hint brands ' + (setEngineBrands(reported) ? 'learned' : 'unavailable; brand hints omitted'));
    } catch {
      log.log('WARN', 'engine client-hint brands unavailable; brand hints omitted');
    }
    if (!chromeWin || chromeWin.isDestroyed()) return;
    // Session restore (crash recovery): reopen tabs from the last session.
    // Named persistent containers are a Standard-mode feature. A later strict
    // startup must not fail while reading an older Standard session file.
    const saved = sessionStore.restoreTabRecords(getRuntimeBase())
      .filter(item => !item.containerId || modeId === 'standard');
    if (saved.length) {
      saved.forEach((item, i) => {
        const t = createTab(item.url, { containerId: item.containerId });
        if (i === 0) switchTab(t.id, { focus: false });
      });
      log.log('INFO', 'session restored', { tabs: saved.length });
    } else {
      const t = createTab('about:blank');
      switchTab(t.id, { focus: false });
    }
    // Links given on the command line ("open with ForgeOS Browser").
    if (!process.argv.includes('--smoke')) openExternalUrls(externalUrls(process.argv));
    sendState();
  });
  chromeWin.webContents.on('will-navigate', (e, url) => {
    // Chrome UI must never navigate to remote content (only file:// + in-app).
    if (!url.startsWith('file://')) { e.preventDefault(); }
  });
  // CSP for the chrome UI: no remote or inline scripts, no connect to
  // anything but the localhost agent API. This session is the chrome UI's own
  // (CHROME_UI_PARTITION), so the page adapter cannot replace this listener.
  // index.html carries the same policy in a meta tag.
  chromeWin.webContents.session.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (details, cb2) => {
    const h = details.responseHeaders || {};
    h['Content-Security-Policy'] = [
      "default-src 'self' file: data:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: file:",
      "connect-src 'self' http://127.0.0.1:8647 ws://127.0.0.1:*",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    cb2({ responseHeaders: h });
  });
  chromeWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromeWin.loadFile(RENDERER);
}

app.on('second-instance', (_event, argv) => {
  // Another launch of the browser: open its links here, or just come forward.
  if (!openExternalUrls(externalUrls(argv)) && chromeWin && !chromeWin.isDestroyed()) {
    if (chromeWin.isMinimized()) chromeWin.restore();
    chromeWin.show();
    chromeWin.focus();
  }
});

app.whenReady().then(() => {
  if (!HAS_INSTANCE_LOCK) return; // a running browser already took over
  // Crash recovery: never die silently. Log the error, show it, and keep the
  // app alive where possible (a renderer/tab crash must not kill the shell).
  process.on('uncaughtException', (err) => {
    try { if (log) log.log('ERROR', 'uncaught exception', { msg: String(err && err.message || err).slice(0, 300) }); } catch {}
    console.error('[forge] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    try { if (log) log.log('ERROR', 'unhandled rejection', { msg: String(reason && reason.message || reason).slice(0, 300) }); } catch {}
  });
  app.on('child-process-gone', (_e, details) => {
    try { if (log) log.log('WARN', 'child process gone', { type: details.type, reason: details.reason }); } catch {}
  });
  app.on('render-process-gone', (_e, _wc, details) => {
    try { if (log) log.log('WARN', 'renderer process gone', { reason: details.reason, exitCode: details.exitCode }); } catch {}
  });

  // Initialize runtime paths now that app is ready (app.getPath is available)
  const EventLogModule = require('./engine/event-log');
  const { FilterEngine } = require('./engine/filter-engine');
  log = new EventLogModule.EventLog(getLogFile(), 2500);
  engine = new FilterEngine({});
  // Load filter lists now
  try {
    for (const f of ['easylist.txt', 'easyprivacy.txt']) {
      const p = path.join(path.dirname(APP_ROOT), 'lists', f);
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        const c = engine.loadAbpLines(lines, { source: f });
        log.log('INFO', `loaded filter list ${f}`, { blockRules: c.blocks.length, exceptions: c.exceptions.length, cosmeticSkipped: c.cosmeticSkipped });
      }
    }
  } catch (e) {
    log.log('ERROR', 'filter list load failed', { error: String(e).slice(0, 200) });
  }

  log.log('INFO', 'Forge Browser Lab started', { version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome });
  applyAppLevelHardening(app);
  log.log('INFO', 'app-level fingerprint posture applied', { ua: 'generic-chrome', pageShims: false });
  registerIpc();
  createChromeWindow();
  initCosmetic();

  // Agent API (v0.4): localhost-only, token-gated read surface for external
  // agents (e.g. Hermes). Reads the ACTIVE tab through the same Agent View
  // pipeline the panels use; navigation goes through the app's own path.
  startAgentApi({
    port: 8647,
    baseDir: getRuntimeBase(),
    log,
    getSnapshot: () => buildState(),
    readPage: async () => {
      const t = activeTab();
      if (!t) return { error: 'no active tab', untrusted: true };
      return refreshAgentView(t); // same pipeline as the panels; marks untrusted
    },
    approveNavigate: (url) => approveAgentNavigation(url),
    // v0.11 agent capabilities: the same page the panels read, now indexed and
    // actionable. Reading is automatic; acting goes through the policy gate.
    requireAgentTab,
    observe: () => readIndexedSnapshot(),
    act: (action) => executeAgentAction(action),
    approveAction: (info) => approveAgentAction(info),
    navigate: navigateAgent,
  }).then((api) => {
    agentApi = api;
    log.log('INFO', 'agent api listening', { url: `http://127.0.0.1:${api.port}`, tokenFile: api.tokenFile });
  })
    .catch((e) => log.log('ERROR', 'agent api failed to start', { error: String(e).slice(0, 150) }));

  scheduleUpdateChecks();

  // --smoke: automated self-check on the REAL app (used by scripts/verify-gates).
  const smoke = process.argv.includes('--smoke');
  if (smoke) setTimeout(runSmoke, 3500);
});

/* ------------------------------------------------------------------------ *
 * Agent capabilities (v0.11): observe -> decide -> act.
 *
 * The page is UNTRUSTED. These run through executeJavaScript on the active
 * tab's webContents, the same path cosmetic filtering already uses, and the tab
 * still receives no bridge. Reading is automatic; an action that commits the
 * user stops at a native dialog first (see action-policy.js for the line).
 *
 * Indexes are only ever resolved back to a live node immediately before acting,
 * so a stale index refuses instead of clicking whatever moved into that spot.
 * ------------------------------------------------------------------------ */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** One atomic read of the active tab: page text plus the numbered element table. */
async function readIndexedSnapshot() {
  const t = activeTab();
  if (!t || !t.wc || t.wc.isDestroyed()) return { error: 'no active tab' };
  try { await requireAgentTab(); }
  catch (error) { return { error: String(error.message || error).slice(0, 200) }; }
  try {
    const url = t.wc.getURL();
    const raw = await t.wc.executeJavaScript(forgeSnapshotScript(true), true);
    if (activeTab() !== t || t.wc.isDestroyed() || t.wc.getURL() !== url)
      return { error: 'page changed during observation' };
    // Raw effect fields may include private query values. Hash them in the
    // trusted process, then remove them before normalization/agent exposure.
    const effectProofHashes = new Map();
    for (const [index, proof] of raw._privateEffectProofs || []) {
      const hash = hashEffectProof(proof);
      if (Number.isSafeInteger(index) && hash) effectProofHashes.set(index, hash);
    }
    delete raw._privateEffectProofs;
    const snapshot = normalizeSnapshot(raw);
    t.lastAgentObservation = { url, snapshot, effectProofHashes };
    // The renderer has scrubbed sensitive value copies from the URL path.
    // The live webContents URL is authority for navigation, not observation.
    return snapshot;
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Main-process authority: caller-supplied value, signal, and JSON witnesses never
// grant an effect. WeakMap identity also prevents a copied action from replaying.
const agentClickApprovals = new WeakMap();

/** Execute one validated action against the active tab. */
async function executeAgentAction(action) {
  const t = activeTab();
  const kind = action && action.kind;

  try {
    await requireAgentTab();
    if (kind === 'wait') {
      await sleepMs(Number(action.ms) || 600);
      await requireAgentTab();
      return { ok: true, detail: 'waited' };
    }
    if (kind === 'scroll') {
      const r = await t.wc.executeJavaScript(forgeScrollScript(action.direction === 'up' ? 'up' : 'down'), true);
      return { ok: !!(r && r.ok), detail: `scrollY=${r && r.y}` };
    }

    let clickProof = null;
    if (['click', 'fill', 'select'].includes(kind) && action && typeof action === 'object') {
      const bound = agentClickApprovals.get(action);
      agentClickApprovals.delete(action); // consume before any await, including a refusal
      if (bound) {
        if (bound.tab !== t || bound.wc !== t.wc || bound.url !== t.wc.getURL() ||
            bound.index !== action.targetIndex || bound.kind !== kind ||
            bound.optionIndex !== action.optionIndex ||
            bound.value !== (action.value == null ? null : String(action.value)))
          return { ok: false, reason: 'approval_required_or_stale' };
        clickProof = { nonce: bound.nonce, descriptor: bound.descriptor, kind: bound.kind,
          value: bound.value, optionIndex: bound.optionIndex,
          effectProofHash: bound.effectProofHash };
      }
    }
    const resolved = await t.wc.executeJavaScript(
      forgeActionScript(action.targetIndex, kind, action.value == null ? null : String(action.value), clickProof),
      true,
    );
    await requireAgentTab();
    if (!resolved || !resolved.ok) {
      return { ok: false, reason: (resolved && resolved.reason) || 'element not resolvable' };
    }
    if (resolved.done) return { ok: true, detail: kind === 'fill' ? 'typed' : kind === 'select' ? 'option selected' : 'clicked' };

    if (kind === 'click') {
      const point = { x: resolved.x, y: resolved.y, button: 'left', clickCount: 1 };
      t.wc.sendInputEvent({ type: 'mouseDown', ...point });
      t.wc.sendInputEvent({ type: 'mouseUp', ...point });
      return { ok: true, detail: `clicked ${resolved.x},${resolved.y}` };
    }
    return { ok: false, reason: `unsupported action kind "${kind}"` };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * Native-dialog gate for an action that commits the user. Native, not HTML:
 * the page view is a separate native layer, so a rendered banner can end up
 * behind it, while a dialog is always visible and cannot be covered.
 */
async function approveAgentAction(info) {
  const action = (info && info.action) || {};
  if (!chromeWin || chromeWin.isDestroyed()) {
    log.log('DENY', 'agent action approval unavailable', { reason: 'no browser window' });
    return false;
  }
  const t = activeTab();
  if (!t || !t.wc || t.wc.isDestroyed()) return false;
  try { await requireAgentTab(); } catch { return false; }
  const wc = t.wc;
  const url = wc.getURL();
  const targetIndex = action.targetIndex;
  const kind = action.kind;
  if (!['click', 'fill', 'select'].includes(kind) || !Number.isSafeInteger(targetIndex)) return false;
  if ((kind === 'fill' || kind === 'select') && action.value == null) return false;
  const value = action.value == null ? null : String(action.value);
  const optionIndex = action.optionIndex;
  // A model or API client never supplies the target proof. The last indexed
  // observation lives in the main process and must still be the one the agent
  // decided from. Another observation/tab navigation invalidates the proposal.
  const binding = t.lastAgentObservation;
  if (t.agentOwned && (!binding || binding.url !== url ||
      binding.snapshot.fingerprint !== action.fingerprint ||
      !binding.effectProofHashes || !binding.effectProofHashes.has(targetIndex) ||
      binding.snapshot.elements.filter(el => el.index === targetIndex && el.kind === kind &&
        (kind !== 'select' || (String(el.option_value) === value &&
          (action.optionIndex == null || el.option_index === action.optionIndex)))).length !== 1)) {
    log.log('DENY', 'agent action preview invalidated', { reason: 'observation changed' });
    return false;
  }
  let nonce, descriptor, display, previewLabel, inspectedEffectHash;
  nonce = require('crypto').randomBytes(24).toString('hex');
  try {
    const inspected = await wc.executeJavaScript(forgeActionScript(targetIndex, 'inspect', nonce, { kind }), true);
    if (!inspected || !inspected.ok || action.targetIndex !== targetIndex || action.kind !== kind ||
        action.optionIndex !== optionIndex ||
        (action.value == null ? null : String(action.value)) !== value ||
        activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url) return false;
    descriptor = inspected.descriptor;
    display = inspected.display;
    if (!descriptor || !display) return false;
    inspectedEffectHash = hashEffectProof(inspected.effectProof);
    if (!inspectedEffectHash) return false;
    previewLabel = display.label;
    if (t.agentOwned) {
      const observed = binding.snapshot.elements.find(el => el.index === targetIndex &&
        (kind !== 'select' || (String(el.option_value) === value &&
          (action.optionIndex == null || el.option_index === action.optionIndex))));
      previewLabel = observed.label || previewLabel;
      const changes = compareAgentPreview(observed, inspected, binding.snapshot.url, kind,
        binding.effectProofHashes.get(targetIndex));
      if (kind === 'select' && (!Array.isArray(descriptor.options) ||
          descriptor.options.filter(option => option[0] === value && !option[1]).length !== 1 ||
          (action.optionIndex != null && (!Number.isSafeInteger(action.optionIndex) ||
            !descriptor.options[action.optionIndex] || descriptor.options[action.optionIndex][0] !== value ||
            descriptor.options[action.optionIndex][1]))))
        changes.push('proposed option');
      if (changes.length || t.lastAgentObservation !== binding) {
        log.log('DENY', 'agent action preview invalidated', { changed: changes.join(', ') || 'observation changed' });
        await dialog.showMessageBox(chromeWin, {
          type: 'warning', title: 'ForgeOS Browser — action changed',
          message: 'The agent action changed since it was observed. Approval expired.',
          detail: `Changed: ${changes.join(', ') || 'page observation'}. Re-observe before trying again.`,
          buttons: ['Close'], defaultId: 0, cancelId: 0, noLink: true,
        });
        return false;
      }
    }
  } catch { return false; }
  const result = await dialog.showMessageBox(chromeWin, {
    type: 'warning',
    title: 'ForgeOS Browser — agent action request',
    message: `Action preview — an external agent wants to ${kind === 'fill' ? 'type into' : kind === 'select' ? 'select an option in' : 'activate'} an element.`,
    detail: `Element: [${action.targetIndex}] ${previewLabel || '(unlabelled element)'}\n` +
      `Current page: ${display.pageUrl}\nDestination: ${display.destination}\n` +
      `Form method: ${display.formMethod || '(not a form)'}\n` +
      (t.agentOwned ? 'Since observation: browser-held target/effect witness matched.\n' :
        'Since observation: unavailable in this test context.\n') +
      (kind !== 'click' ? `Field: ${descriptor.tag} name=${display.fieldName || '(none)'} id=${display.fieldId || '(none)'}\n` : '') +
      'JavaScript event handlers may have additional unknown side effects.\n' +
      (kind !== 'click' ? 'The proposed text is hidden for privacy.\n' : '') +
      '\nWhy this needs you: this interaction may change the page or submit data.\n' +
      '\nAllow only if you asked for this.',
    buttons: ['Deny', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  let allowed = result.response === 1;
  if (allowed && descriptor) {
    try {
      if (action.targetIndex !== targetIndex || action.kind !== kind || action.optionIndex !== optionIndex ||
          (action.value == null ? null : String(action.value)) !== value ||
          activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url ||
          (t.agentOwned && t.lastAgentObservation !== binding)) allowed = false;
      else {
        const current = await wc.executeJavaScript(forgeActionScript(targetIndex, 'recheck', nonce, { kind }), true);
        if (!current || !current.ok || action.targetIndex !== targetIndex ||
            action.optionIndex !== optionIndex ||
            action.kind !== kind || (action.value == null ? null : String(action.value)) !== value ||
            JSON.stringify(current.descriptor) !== JSON.stringify(descriptor) ||
            hashEffectProof(current.effectProof) !== inspectedEffectHash ||
            (t.agentOwned && hashEffectProof(current.effectProof) !== binding.effectProofHashes.get(targetIndex)) ||
            activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url) allowed = false;
      }
    } catch { allowed = false; }
    if (allowed) {
      try { await requireAgentTab(); } catch { allowed = false; }
      if (allowed) agentClickApprovals.set(action, { tab: t, wc, url, index: targetIndex,
        kind, value, optionIndex, nonce, descriptor, effectProofHash: inspectedEffectHash });
    }
  }
  log.log(allowed ? 'ALLOW' : 'DENY', 'agent action human decision', {
    kind: action.kind, label: previewLabel, why: 'interaction requires approval', decision: allowed ? 'allow' : 'deny',
  });
  return allowed;
}


app.on('window-all-closed', () => {
  // Persist open tabs for next launch (crash recovery) unless quitting
  // is explicitly "clean" (forget-mode handled per-tab already).
  if (tabs.size) persistOpenTabs();
  else sessionStore.clear(getRuntimeBase());
  app.quit();
});

app.on('before-quit', () => {
  agentQuitting = true;
  agentNavigationEpoch++;
  if (agentTabId != null) closeTab(agentTabId).catch(() => {});
  else if (agentLease) {
    const lease = agentLease;
    agentLease = null;
    lease.stop().catch(() => {});
  }
  const api = agentApi;
  agentApi = null;
  if (!api) return;
  api.stop()
    .then(({ tokenRemoved }) => log.log('INFO', 'agent api stopped', { tokenRemoved }))
    .catch((error) => log.log('ERROR', 'agent api stop failed', { error: String(error).slice(0, 160) }));
});

// Explicitly disable anything that could phone home from this project.
app.setAppUserModelId('forge.browser.lab');
