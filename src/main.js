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
const { PluginRunner } = require('./ext/plugins');
const { sessionPlanFor, clearSessionData } = require('./engine/storage-manager');
const { MODES, isValidMode } = require('./engine/privacy-modes');
const { analyzeAgentView, IN_PAGE_SCRIPT, readPageView } = require('./engine/agent-view');
const { applyAppLevelHardening } = require('./engine/fingerprint-hardening');
const { requestAction } = require('./engine/permissions');
const settings = require('./engine/settings');
const bh = require('./engine/bookmarks-history');
const allowlist = require('./engine/site-allowlist');
const { compileCosmetic, selectorsForHost } = require('./engine/cosmetic-engine');
const { startAgentApi } = require('./ext/agent-api');
const credentialPolicy = require('./engine/credential-policy');
const { browserViewBounds } = require('./engine/view-layout');
const sessionStore = require('./engine/session-store');
const { cleanUrlString } = require('./engine/url-cleaner');
const { classifyField } = require('./engine/sensitive-fields');
const { createPageWebPreferences } = require('./page-web-preferences');
const { DARK_SCROLLBAR_CSS, supportsPageAppearance } = require('./engine/page-appearance');
const { isExistingPathInside, upsertDownload } = require('./engine/download-center');

const TOOLBAR_H = 42; // must match renderer CSS --bar-h
let menuRightInset = 0;
const APP_ROOT = __dirname;
const RENDERER = path.join(APP_ROOT, 'renderer', 'index.html');

// Runtime-writable dirs: use app.getPath('userData') when packaged (OS-sanctioned
// config location). A .portable marker file next to the executable overrides to
// keep dirs local to the executable (USB-drive / portable mode).
// Dev (no asar): project root is fine.
const IS_PACKAGED = __dirname.includes('app.asar');

function getRuntimeBase() {
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

// Lazy: log is initialized inside app.whenReady() so getRuntimeBase() can use
// app.getPath.  Top-level code before ready uses a no-op fallback.
let log = { log: () => {} }; // no-op until real init
let engine = null;
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
const downloads = [];
const plugins = new PluginRunner({ log });

function getSessionFor(partitionKey) {
  if (partitionKey == null) {
    let e = sessions.get('__default__');
    if (!e) {
      const s = session.defaultSession;
      e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, downloadsDir: DL_DIR(), getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r) }) };
      sessions.set('__default__', e);
    }
    return e;
  }
  let e = sessions.get(partitionKey);
  if (!e) {
    const s = session.fromPartition(partitionKey);
    e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, downloadsDir: DL_DIR(), getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r) }) };
    sessions.set(partitionKey, e);
  }
  return e;
}

function pushDownload(record) {
  const saved = upsertDownload(downloads, record, 50);
  if (saved) sendToChrome('forge:download', saved);
  return saved;
}

function pluginDownloadRecord(event, context) {
  if (!event || !event.jobId) return null;
  const state = event.state === 'done' ? 'completed'
    : event.state === 'progress' ? 'running'
      : event.state;
  let sourceDomain = '';
  try { sourceDomain = new URL(context.url).hostname; } catch {}
  const safeFiles = Array.isArray(event.files)
    ? event.files.filter((file) => isExistingPathInside(DL_DIR(), file))
    : [];
  const preferred = safeFiles.find((file) => context.kind === 'transcript' ? /\.txt$/i.test(file) : /\.mp4$/i.test(file))
    || safeFiles[0]
    || null;
  let size = null;
  if (preferred) {
    try { size = fs.statSync(preferred).size; } catch {}
  }
  return pushDownload({
    id: event.jobId,
    kind: 'plugin',
    pluginKind: event.kind || context.kind,
    filename: preferred ? path.basename(preferred) : context.label,
    source_domain: sourceDomain,
    url: context.url,
    state,
    pct: state === 'completed' ? 100 : event.pct,
    speed: event.speed || null,
    eta: event.eta || null,
    totalLabel: event.total || null,
    size,
    content_type: context.kind === 'transcript' ? 'text/plain' : 'video/mp4',
    path: preferred,
    files: safeFiles,
    error: event.error || null,
    warning: event.warning || null,
    cancellable: state === 'running',
    retryable: state === 'error' || state === 'cancelled',
    executable: false,
  });
}

async function runPluginJob(kind, pageUrl, label) {
  const context = {
    kind,
    url: pageUrl,
    label: label || (kind === 'transcript' ? 'YouTube transcript' : 'YouTube video'),
  };
  const result = await plugins.run(
    kind,
    pageUrl,
    async () => {
      if (!chromeWin) return { approved: false };
      const response = await dialog.showMessageBox(chromeWin, {
        type: 'question',
        title: 'ForgeOS Browser — approval required',
        message: `Plugin wants to ${kind === 'transcript' ? 'fetch a transcript' : 'download the video'} from this page`,
        detail: pageUrl,
        buttons: ['Deny', 'Approve'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      const approved = response.response === 1 && !response.checkboxChecked;
      log.log(approved ? 'ALLOW' : 'DENY', 'plugin approval ' + (approved ? 'granted' : 'denied'), { url: pageUrl.slice(0, 200), kind });
      return { approved };
    },
    (event) => {
      pluginDownloadRecord(event, context);
      sendToChrome('forge:plugin-event', event);
    }
  );
  if (result.state !== 'started') pluginDownloadRecord(result, context);
  return result;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function createTab(url = 'about:blank', opts = {}) {
  const id = ++tabSeq;
  const plan = sessionPlanFor(url, modeId, !!opts.forgetOnClose);
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
    id, view, wc, adapter, partition: plan.partition,
    url, title: '', history: [], index: -1,
    forgetOnClose: !!opts.forgetOnClose,
    certError: false,
    pageCounts: { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 },
    lastAgentView: null,
  };
  tabs.set(id, tab);

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    sendState();
  });

  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) tab.certError = false;
  });

  wc.on('did-navigate', (_e, url, httpCode) => {
    // NO-CREDENTIALS policy: intercept identity-provider sign-in pages and
    // show a clear notice instead of Google's misleading "may not be secure".
    if (credentialPolicy.matchesCredentialHost(url) && !settings.all().allowCredentials) {
      // Per-site opt-in? (user accepted the risk in the badge menu)
      let optedIn = false;
      try { optedIn = settings.all().credentialOptIn?.[new URL(url).hostname.toLowerCase().replace(/^www\./, '')] === true; } catch {}
      if (!optedIn) {
        const notice = credentialPolicy.NOTICE_HTML(new URL(url).hostname);
        wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(notice));
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
    bh.addHistory({ url, title: wc.getTitle() });
    injectPageAppearance(tab, url);
    injectCosmetic(tab, url);
    injectDomRemoval(tab, url);
    // Crash recovery: persist open tabs on every navigation so a force-kill
    // or crash at any moment can restore the last good state.
    try { sessionStore.captureOpenTabs(tabs, getRuntimeBase()); } catch {}
    sendState();
  });

  // DOM removal pass: cosmetic CSS hides ad boxes, but testers (turtlecute)
  // score "blocked" only when the element is REMOVED. After the page settles,
  // executeJavaScript removes matched elements entirely. Runs once per
  // navigation; respects blockAds toggle + allowlist via same gate as CSS.
  let domRemovalTimer = null;
  wc.on('did-finish-load', () => {
    if (domRemovalTimer) clearTimeout(domRemovalTimer);
    domRemovalTimer = setTimeout(() => injectDomRemoval(tab, wc.getURL()), 1200);
  });

  wc.on('did-navigate-in-page', (_e, url) => {
    tab.url = url;
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    sendState();
  });

  wc.on('did-finish-load', () => {
    refreshAgentView(tab).then(() => sendState()).catch(() => {});
  });

  wc.on('certificate-error', (_e, url, error) => {
    // Never bypass TLS validation (Phase 17 / constraints).
    tab.certError = true;
    log.log('ERROR', 'certificate error (blocked)', { url: url.slice(0, 200), error: String(error).slice(0, 120) });
    sendState();
  });

  wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
    if (code === -3) return; // aborted
    log.log('ERROR', 'load failed', { code, desc: String(desc).slice(0, 120), url: String(validatedURL).slice(0, 200) });
  });

  wc.on('render-process-gone', (_e, details) => {
    log.log('ERROR', 'renderer gone', { reason: details.reason, exitCode: details.exitCode });
  });

  // window.open is denied: no untrusted content opens its own chrome.
  wc.setWindowOpenHandler(({ url }) => {
    log.log('DENY', 'window.open blocked', { url: url.slice(0, 200) });
    return { action: 'deny' };
  });

  if (url !== 'about:blank' && url !== '') {
    wc.loadURL(url).catch(() => {});
  }
  return tab;
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
  } catch (e) {
    // Some pages (devtools, crashes) cannot be extracted; the agent view is
    // still produced with untrusted:true and whatever is known.
    tab.lastAgentView = analyzeAgentView({ url: tab.url, title: tab.title }, { trackersBlocked: tab.pageCounts, modeId });
    sendToChrome('forge:agent-view', { tabId: tab.id, agentView: tab.lastAgentView, error: String(e).slice(0, 120) });
  }
}

function layoutActiveView() {
  if (!chromeWin || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const { width, height } = chromeWin.getContentBounds();
  tab.view.setBounds(browserViewBounds({
    width, height, toolbarHeight: TOOLBAR_H, rightInset: menuRightInset,
  }));
  tab.view.setVisible(true);
}

function switchTab(id, { focus = true } = {}) {
  const prev = tabs.get(activeTabId);
  if (prev) chromeWin.contentView.removeChildView(prev.view);
  const tab = tabs.get(id);
  if (!tab) return;
  activeTabId = id;
  chromeWin.contentView.addChildView(tab.view);
  layoutActiveView();
  if (focus && tab.wc) tab.wc.focus();
  tab.pageCounts = tab.adapter.takeDelta();
  sendState();
}

async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.forgetOnClose || modeId === 'ephemeral' || tab.partition) {
    try { await clearSessionData(tab.adapter.session); } catch {}
    log.log('INFO', 'site data cleared on tab close', { url: tab.url.slice(0, 200), partition: tab.partition || 'default' });
  }
  chromeWin.contentView.removeChildView(tab.view);
  tab.wc.close();
  tabs.delete(id);
  if (activeTabId === id) {
    activeTabId = null;
    const next = [...tabs.keys()].pop();
    if (next != null) switchTab(next, { focus: false });
  }
  sendState();
}

function activeTab() {
  return tabs.get(activeTabId) || null;
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
    privacyDefaults: require('./engine/fingerprint').PERMISSION_DEFAULTS,
  };
}

function sendState() { sendToChrome('forge:state', buildState()); }

function registerIpc() {
  ipcMain.handle('forge:navigate', (_e, url) => {
    const t = activeTab();
    return t ? navigateIn(t, url) : null;
  });
  ipcMain.handle('forge:back', () => {
    const t = activeTab();
    if (!t || t.index <= 0) return false;
    t.index -= 1;
    t.wc.goBack();
    return true;
  });
  ipcMain.handle('forge:forward', () => {
    const t = activeTab();
    if (!t || t.index >= t.history.length - 1) return false;
    t.index += 1;
    t.wc.goForward();
    return true;
  });
  ipcMain.handle('forge:reload', () => {
    const t = activeTab();
    if (!t) return false;
    t.wc.reload();
    return true;
  });
  ipcMain.handle('forge:new-tab', (_e, url) => {
    const t = createTab(url || 'about:blank');
    switchTab(t.id, { focus: true });
    return { id: t.id };
  });
  ipcMain.handle('forge:close-tab', (_e, id) => closeTab(id));
  ipcMain.handle('forge:switch-tab', (_e, id) => { if (tabs.has(id)) switchTab(id); });
ipcMain.handle('forge:set-menu-open', (_e, state) => {
    if (!chromeWin || !activeTabId) return false;
    const open = typeof state === 'object' ? !!state.open : !!state;
    menuRightInset = open ? Math.max(0, Number(state && state.rightInset) || 0) : 0;
    layoutActiveView();
    return true;
  });
  ipcMain.handle('forge:set-mode', (_e, m) => {
    if (!isValidMode(m)) return false;
    modeId = m;
    log.log('INFO', 'privacy mode changed', { mode: m });
    sendState();
    return true;
  });
  ipcMain.handle('forge:toggle-panel', (_e, section) => {
    togglePanels(section === 'downloads' ? 'downloads' : null);
    return true;
  });
  ipcMain.handle('forge:clear-session', async () => {
    log.log('INFO', 'clear session requested');
    const todo = new Set(sessions.values());
    let removed = 0;
    for (const { session: s } of todo) removed += await clearSessionData(s);
    for (const t of tabs.values()) {
      t.history = []; t.index = -1; t.lastAgentView = null;
      t.pageCounts = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 };
      t.adapter.resetCounters();
      t.adapter.takeDelta();
    }
    downloads.length = 0;
    bh.clearHistory();
    log.log('INFO', 'clear session complete', { cookiesRemoved: removed });
    sendState();
    return true;
  });
  ipcMain.handle('forge:set-forget', (_e, on) => {
    const t = activeTab();
    if (!t) return false;
    t.forgetOnClose = !!on;
    log.log('INFO', 'forget-on-close ' + (on ? 'enabled' : 'disabled'), { url: t.url.slice(0, 200) });
    sendState();
    return true;
  });
  ipcMain.handle('forge:open-devtools', (_e, id) => {
    const t = tabs.get(id) || activeTab();
    if (t) t.wc.openDevTools({ mode: 'detach' });
  });
  ipcMain.handle('forge:agent-view', () => activeTab()?.lastAgentView || null);
  ipcMain.handle('forge:read-page', () => readPageView(activeTab()?.lastAgentView || null));
  ipcMain.handle('forge:get-links', () => (activeTab()?.lastAgentView?.content.links) || []);
  ipcMain.handle('forge:security-status', () => {
    const t = activeTab();
    return t ? { url: t.url, security: securityFor(t), counts: t.pageCounts, injection: t.lastAgentView?.security || null, mode: modeId } : null;
  });
  ipcMain.handle('forge:get-state', () => buildState());
  ipcMain.handle('forge:click', async (_e, selector) => {
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
      t.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
      t.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
      log.log('ALLOW', 'agent click dispatched', { selector, url: t.url.slice(0, 200) });
      return { verdict: 'ALLOW', reason: 'click dispatched', at: probe };
    } catch (e) {
      return { verdict: 'DENY', reason: 'click failed: ' + String(e).slice(0, 120) };
    }
  });
  ipcMain.handle('forge:request-action', (_e, action, details) => approveAction(action, details || {}));

  // Plugins (⬇ video / ✎ transcript): URL comes from the ACTIVE tab only;
  // the action passes the permission gate before yt-dlp ever starts.
  ipcMain.handle('forge:plugin', (_e, kind) => {
    if (kind !== 'video' && kind !== 'transcript') {
      return { state: 'error', error: 'Unsupported plugin action.' };
    }
    const t = activeTab();
    if (!t || !t.url || !/^https?:/i.test(t.url)) {
      return { state: 'error', error: 'Open a video page first.' };
    }
    return runPluginJob(kind, t.url, t.title);
  });
  ipcMain.handle('forge:plugin-cancel', (_e, jobId) => plugins.cancel(jobId));
  ipcMain.handle('forge:download-cancel', (_e, id) => {
    if (plugins.cancel(id)) return true;
    for (const entry of sessions.values()) {
      if (entry.adapter.cancelDownload(id)) return true;
    }
    return false;
  });
  ipcMain.handle('forge:download-retry', (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || record.kind !== 'plugin' || !record.retryable || !record.url) {
      return { state: 'error', error: 'This download cannot be retried.' };
    }
    return runPluginJob(record.pluginKind, record.url, record.filename);
  });
  ipcMain.handle('forge:download-open', async (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || record.executable || !isExistingPathInside(DL_DIR(), record.path)) return false;
    const error = await shell.openPath(record.path);
    return !error;
  });
  ipcMain.handle('forge:download-reveal', (_e, id) => {
    const record = downloads.find((item) => item.id === id);
    if (!record || !isExistingPathInside(DL_DIR(), record.path)) return false;
    shell.showItemInFolder(record.path);
    return true;
  });
  // Settings: load all / patch subset; the adapter reads them live per request.
  ipcMain.handle('forge:settings-get', () => settings.all());
  ipcMain.handle('forge:settings-set', (_e, patch) => {
    const res = settings.save(patch || {});
    if (res.ok) log.log('INFO', 'settings updated', { keys: Object.keys(patch || {}).join(',') });
    return res;
  });
  ipcMain.handle('forge:version', () => app.getVersion());
  ipcMain.handle('forge:ytdlp-status', () => {
    // Path inspection only: opening the menu must never launch an external
    // process. Actual tools start only after the plugin approval dialog.
    return require('./ext/plugins').toolchainStatus();
  });

  /* ---- per-site allowlist + zoom (v0.3) ---- */
  ipcMain.handle('forge:allow-is', (_e, host) => ({ allowed: allowlist.isAllowed(host) }));
  ipcMain.handle('forge:presets-list', () => ({
    available: Object.entries(allowlist.TRUST_PRESETS).map(([name, hosts]) => ({ name, hosts: hosts.length })),
    active: allowlist.activePresets(),
  }));
  ipcMain.handle('forge:preset-apply', (_e, name) => {
    const r = allowlist.applyPreset(String(name || ''));
    if (r.ok) { sendState(); log.log('INFO', 'trust preset applied', { preset: name, added: r.addedCount }); }
    return r;
  });
  ipcMain.handle('forge:preset-revoke', (_e, name) => {
    const r = allowlist.revokePreset(String(name || ''));
    if (r.ok) { sendState(); log.log('INFO', 'trust preset revoked', { preset: name, revoked: r.revokedCount }); }
    return r;
  });
  ipcMain.handle('forge:allow-add', (_e, host) => {
    const r = allowlist.add(host);
    if (r.ok) log.log('INFO', 'site allowlisted (blocking disabled)', { host: r.host });
    return r;
  });
  ipcMain.handle('forge:cred-allow', (_e, host) => {
    // Per-site opt-in to the no-credentials policy ("Allow sign-in here").
    const s = settings.all();
    const map = s.credentialOptIn || {};
    map[String(host || '').toLowerCase().replace(/^www\./, '')] = true;
    settings.set({ credentialOptIn: map });
    log.log('INFO', 'sign-in allowed per-site opt-in', { host });
    return { ok: true };
  });
  ipcMain.handle('forge:cred-allowed', (_e, host) => {
    const map = settings.all().credentialOptIn || {};
    return { allowed: !!map[String(host || '').toLowerCase().replace(/^www\./, '')] };
  });
  ipcMain.handle('forge:allow-remove', (_e, host) => {
    const r = allowlist.remove(host);
    if (r.ok) log.log('INFO', 'site allowlist removed', { host });
    return r;
  });
  ipcMain.handle('forge:set-zoom', (_e, pct) => {
    const z = Math.max(50, Math.min(200, Number(pct) || 100));
    settings.save({ pageZoom: z });
    const t = activeTab();
    if (t) t.wc.setZoomFactor(z / 100);
    log.log('INFO', 'zoom set', { pct: z });
    return true;
  });

  /* ---- bookmarks & history (local-first, v0.2) ---- */
  ipcMain.handle('forge:bm-list', () => bh.listBookmarks());
  ipcMain.handle('forge:bm-add', (_e, item) => {
    const r = bh.addBookmark(item || {});
    log.log(r.ok && !r.duplicate ? 'INFO' : 'ALLOW', 'bookmark added', { url: String(item?.url || '').slice(0, 200) });
    return r;
  });
  ipcMain.handle('forge:bm-remove', (_e, id) => bh.removeBookmark(id));
  ipcMain.handle('forge:bm-is', (_e, url) => ({ bookmarked: bh.isBookmarked(url) }));
  ipcMain.handle('forge:hist-list', () => bh.listHistory());
  ipcMain.handle('forge:hist-remove', (_e, id) => bh.removeFromHistory(id));
  ipcMain.handle('forge:hist-clear', () => bh.clearHistory());
  // 📁 open the laboratory downloads folder in the OS file manager
  ipcMain.handle('forge:open-downloads', async () => {
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

  chromeWin = new BrowserWindow(winOpts);
  chromeWin.setMenuBarVisibility(false);
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
  chromeWin.webContents.once('did-finish-load', () => {
    // Session restore (crash recovery): reopen tabs from the last session.
    const saved = sessionStore.restoreTabs(getRuntimeBase());
    if (saved.length) {
      saved.forEach((u, i) => {
        const t = createTab(u);
        if (i === 0) switchTab(t.id, { focus: false });
      });
      log.log('INFO', 'session restored', { tabs: saved.length });
    } else {
      const t = createTab('about:blank');
      switchTab(t.id, { focus: false });
    }
    sendState();
  });
  chromeWin.webContents.on('will-navigate', (e, url) => {
    // Chrome UI must never navigate to remote content (only file:// + in-app).
    if (!url.startsWith('file://')) { e.preventDefault(); }
  });
  // CSP for the chrome UI: no remote scripts/styles, no inline eval, no
  // connect to anything but localhost agent API. Hygiene for a file:// shell.
  chromeWin.webContents.session.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (details, cb2) => {
    const h = details.responseHeaders || {};
    h['Content-Security-Policy'] = [
      "default-src 'self' file: data:",
      "script-src 'self' 'unsafe-inline'",   // chrome UI uses inline handlers
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

app.whenReady().then(() => {
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
    navigate: (url) => new Promise((resolve, reject) => {
      const t = activeTab();
      if (!t) return reject(new Error('no active tab'));
      navigateIn(t, url);
      resolve();
    }),
  }).then((api) => log.log('INFO', 'agent api listening', { url: `http://127.0.0.1:${api.port}`, tokenFile: api.tokenFile }))
    .catch((e) => log.log('ERROR', 'agent api failed to start', { error: String(e).slice(0, 150) }));

  // --smoke: automated self-check on the REAL app (used by scripts/verify-gates).
  const smoke = process.argv.includes('--smoke');
  if (smoke) setTimeout(runSmoke, 3500);
});

/* Cosmetic filtering (v0.4): compile "##" rules once at startup; inject a
 * stylesheet into every page before its scripts run. Toggled by settings. */
let cosmetic = null;
function initCosmetic() {
  try {
    const fs = require('fs');
    const lines = [];
    // Lists live inside the asar when packaged: <asar>/src → <asar>/lists.
    const listsDir = __dirname.includes('app.asar')
      ? path.join(__dirname, '..', 'lists')
      : path.join(__dirname, '..', 'lists');
    for (const f of ['easylist.txt', 'easyprivacy.txt']) {
      const p = path.join(listsDir, f);
      if (!fs.existsSync(p)) continue;
      for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
        if (l.includes('##') || l.includes('#@#')) lines.push(l);
      }
    }
    cosmetic = compileCosmetic(lines);
    log.log('INFO', 'cosmetic rules compiled', cosmetic.stats);
  } catch (e) {
    log.log('ERROR', 'cosmetic compile failed', { error: String(e).slice(0, 150) });
    cosmetic = { genericCss: '', byDomain: new Map(), stats: {} };
  }
}

/** Apply browser-owned visual chrome to web content without a page preload. */
function injectPageAppearance(tab, url) {
  if (!tab || !supportsPageAppearance(url)) return;
  tab.wc.insertCSS(DARK_SCROLLBAR_CSS, { cssOrigin: 'user' }).catch(() => {});
}

/** Inject cosmetic CSS into a page view (native insertCSS — no JS cost). */
function injectCosmetic(tab, url) {
  if (!cosmetic || !tab || !url.startsWith('http')) return;
  try {
    if (settings.all().blockAds === false) return; // user toggle respected
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    // Per-site allowlist also disables cosmetic hiding.
    if (host && allowlist.isAllowed(host)) return;
    const hostSelectors = selectorsForHost(cosmetic, host);
    const css = [
      cosmetic.genericCss,
      ...hostSelectors.map((s) => `${s}{display:none!important}`),
    ].filter(Boolean).join('\n');
    if (!css) return;
    tab.wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
  } catch {}
}

/** DOM removal pass: DELETE matched elements (testers score "removed" > hidden). */
function injectDomRemoval(tab, url) {
  if (!cosmetic || !tab || !url.startsWith('http')) return;
  try {
    if (settings.all().blockAds === false) return;
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (host && allowlist.isAllowed(host)) return;
    const hostSelectors = selectorsForHost(cosmetic, host);
    const generic = cosmetic.genericSelectors || [];
    const selectors = [...new Set([...generic, ...hostSelectors])]
      .filter((s) => s && s.length < 200 && !/[:{}]/.test(s)) // safe subset only
      .slice(0, 4000);
    if (!selectors.length) return;
    const js = `(function(){
      let removed = 0;
      for (const sel of ${JSON.stringify(selectors)}) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            if (el && el.parentNode) { el.parentNode.removeChild(el); removed++; }
          });
        } catch {}
      }
      return removed;
    })()`;
    tab.wc.executeJavaScript(js, true).catch(() => {});
  } catch {}
}


let smokeDone = false;
async function runSmoke() {
  if (smokeDone) return;
  smokeDone = true;
  const fs = require('fs');
  const reportPath = path.join(path.dirname(APP_ROOT), 'results', 'smoke-report.json');
  const finish = (code) => {
    // Merge finished/code onto any report already written (do not clobber it).
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(reportPath, 'utf8') || '{}'); } catch {}
    obj.finished = true;
    obj.code = code;
    try { fs.writeFileSync(reportPath, JSON.stringify(obj, null, 2)); } catch {}
    setTimeout(() => app.exit(code), 4500); // hold ~4.5s so the window can be captured
  };
  try {
    log.log('INFO', 'smoke start');
    const t = createTab('https://example.com');
    switchTab(t.id, { focus: false });
    log.log('INFO', 'smoke tab created', { id: t.id });
    const navOk = await new Promise((resolve) => {
      let settled = false;
      const done = (ok, extra) => { if (!settled) { settled = true; resolve(extra || ok); } };
      t.wc.once('did-navigate', () => {
        log.log('INFO', 'smoke did-navigate');
        setTimeout(async () => {
          await refreshAgentView(t);
          done(true);
        }, 1200);
      });
      t.wc.once('did-fail-load', (_e, code, desc) => { log.log('ERROR', 'smoke did-fail-load', { code, desc: String(desc).slice(0, 100) }); done(false, { failed: code }); });
      setTimeout(() => done(false, { failed: 'timeout' }), 25000);
    });
    const report = {
      smoke: true,
      url: t.url,
      title: t.title,
      security: securityFor(t),
      pageCounts: t.pageCounts,
      agentView: t.lastAgentView ? {
        url: t.lastAgentView.url,
        title: t.lastAgentView.title,
        untrusted: t.lastAgentView.security.untrusted,
        authority: t.lastAgentView.security.instruction_authority,
        injection: t.lastAgentView.security.prompt_injection_severity,
        paragraphs: (t.lastAgentView.content.paragraphs || []).slice(0, 2),
        links: (t.lastAgentView.content.links || []).slice(0, 3),
      } : null,
      navigation: navOk === true ? 'OK' : JSON.stringify(navOk),
    };
    report.pageBoundary = await t.wc.executeJavaScript(`({
      processType: typeof window.process,
      requireType: typeof window.require,
      forgeType: typeof window.forge,
      electronType: typeof window.electron
    })`);
    report.pageBoundary.safe = report.pageBoundary.processType === 'undefined' &&
      report.pageBoundary.requireType === 'undefined' &&
      report.pageBoundary.forgeType === 'undefined' &&
      report.pageBoundary.electronType === 'undefined';
    console.log('SMOKE_REPORT ' + JSON.stringify(report));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const pass = report.security && report.security.label === 'HTTPS' && navOk === true && report.pageBoundary.safe;
    log.log(pass ? 'INFO' : 'ERROR', 'smoke ' + (pass ? 'PASS' : 'FAIL'), { url: report.url, security: report.security && report.security.label, title: report.title });
    finish(pass ? 0 : 1);
  } catch (e) {
    const detail = { smoke: true, error: String(e && e.stack || e).slice(0, 500) };
    console.log('SMOKE_REPORT ' + JSON.stringify(detail));
    log.log('ERROR', 'smoke failed', { error: String(e).slice(0, 200) });
    try { fs.writeFileSync(reportPath, JSON.stringify(detail, null, 2)); } catch {}
    setTimeout(() => app.exit(2), 400);
  }
}

app.on('window-all-closed', () => {
  // Persist open tabs for next launch (crash recovery) unless quitting
  // is explicitly "clean" (forget-mode handled per-tab already).
  if (tabs.size) sessionStore.captureOpenTabs(tabs, getRuntimeBase());
  app.quit();
});

// Explicitly disable anything that could phone home from this project.
app.setAppUserModelId('forge.browser.lab');
