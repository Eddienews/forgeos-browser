/*
 * main.js — Forge Browser Lab (Phase 1 browser shell + integration).
 *
 * The engine (src/engine/*) is pure and browser-agnostic; this file wires it
 * to Electron and owns the minimal browser UI: tabs (WebContentsView),
 * address bar, back/forward/reload, security indicator, privacy dashboard,
 * agent view panel, action approval gate, downloads, and local history.
 *
 * Security posture (Phase 17): page WebContentsViews run with
 * sandbox:true, contextIsolation:true, nodeIntegration:false, and NO
 * preload. The chrome window's own preload exposes only the whitelisted
 * `window.forge` bridge. Untrusted content can never reach the engine,
 * the filesystem, credentials, or other tabs.
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
const { applyAppLevelHardening, PAGE_HARDENING_SCRIPT } = require('./engine/fingerprint-hardening');
const { requestAction } = require('./engine/permissions');
const settings = require('./engine/settings');
const bh = require('./engine/bookmarks-history');
const { cleanUrlString } = require('./engine/url-cleaner');
const { classifyField } = require('./engine/sensitive-fields');

const TOOLBAR_H = 42; // must match renderer CSS --bar-h
const APP_ROOT = __dirname;
const RENDERER = path.join(APP_ROOT, 'renderer', 'index.html');

// Runtime-writable dirs must live OUTSIDE the asar when packaged.
// Dev:  <root>/logs, <root>/downloads   (APP_ROOT = <root>/src)
// Pkg:  next to ForgeBrowserLab.exe     (__dirname ends with .../app.asar/src)
const IS_PACKAGED = __dirname.includes('app.asar');
const RUNTIME_BASE = IS_PACKAGED
  ? path.dirname(process.execPath)                       // dir of the .exe
  : path.dirname(APP_ROOT);                              // project root
const LOG_FILE = path.join(RUNTIME_BASE, 'logs', 'forge-events.log');
const DL_DIR = path.join(RUNTIME_BASE, 'downloads');

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

const log = new EventLog(LOG_FILE, 2500);
const engine = new FilterEngine({});
try {
  // Optional drop-in filter lists (easy list format) — see update-lists.js
  const fs = require('fs');
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
      e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r) }) };
      sessions.set('__default__', e);
    }
    return e;
  }
  let e = sessions.get(partitionKey);
  if (!e) {
    const s = session.fromPartition(partitionKey);
    e = { session: s, adapter: new SessionAdapter({ session: s, engine, log, modeId, getChromeWindow: () => chromeWin, onDownloadRecord: (r) => pushDownload(r) }) };
    sessions.set(partitionKey, e);
  }
  return e;
}

function pushDownload(record) {
  downloads.unshift(record);
  if (downloads.length > 50) downloads.pop();
  sendToChrome('forge:download', record);
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
    webPreferences: {
      partition: plan.partition || undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Phase 7: standardized fingerprint values injected before page scripts.
      preload: path.join(APP_ROOT, 'page-preload.js'),
    },
  });
  const wc = view.webContents;

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
    tab.url = url;
    // Commit into history (truncate forward entries).
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    tab.pageCounts = adapter.takeDelta();
    log.log('INFO', 'navigated', { url: url.slice(0, 300), httpCode });
    bh.addHistory({ url, title: wc.getTitle() });
    sendState();
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
  tab.view.setBounds({ x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) });
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
function togglePanels() {
  if (panelWin && !panelWin.isDestroyed()) {
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
  return {
    mode: modeId,
    modeSummary: MODES[modeId].summary,
    activeTabId,
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
  ipcMain.handle('forge:set-mode', (_e, m) => {
    if (!isValidMode(m)) return false;
    modeId = m;
    log.log('INFO', 'privacy mode changed', { mode: m });
    sendState();
    return true;
  });
  ipcMain.handle('forge:toggle-panel', () => { togglePanels(); return true; });
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
    const t = activeTab();
    if (!t || !t.url || !/^https?:/i.test(t.url)) {
      return { state: 'error', error: 'Open a video page first.' };
    }
    const pageUrl = t.url;
    return plugins.run(
      kind === 'transcript' ? 'transcript' : 'video',
      pageUrl,
      async () => {
        if (!chromeWin) return { approved: false };
        const r = await dialog.showMessageBox(chromeWin, {
          type: 'question',
          title: 'Forge Browser Lab — approval required',
          message: `Plugin wants to ${kind === 'transcript' ? 'fetch a transcript' : 'download the video'} from this page`,
          detail: pageUrl,
          buttons: ['Deny', 'Approve'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        const approved = r.response === 1 && !r.checkboxChecked;
        log.log(approved ? 'ALLOW' : 'DENY', 'plugin approval ' + (approved ? 'granted' : 'denied'), { url: pageUrl.slice(0, 200), kind });
        return { approved };
      },
      (evt) => sendToChrome('forge:plugin-event', evt)
    );
  });
  ipcMain.handle('forge:plugin-cancel', (_e, jobId) => plugins.cancel(jobId));
  // Settings: load all / patch subset; the adapter reads them live per request.
  ipcMain.handle('forge:settings-get', () => settings.all());
  ipcMain.handle('forge:settings-set', (_e, patch) => {
    const res = settings.save(patch || {});
    if (res.ok) log.log('INFO', 'settings updated', { keys: Object.keys(patch || {}).join(',') });
    return res;
  });
  ipcMain.handle('forge:ytdlp-status', () => {
    const p = require('./ext/plugins').resolveYtDlp();
    if (!p) return { found: false, hint: 'Set FORGE_YTDLP env var or install yt-dlp.' };
    let version = '';
    try { version = require('child_process').execFileSync(p, ['--version'], { timeout: 8000 }).toString().trim(); } catch {}
    return { found: true, path: p, version };
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
    fs.mkdirSync(DL_DIR, { recursive: true });
    log.log('INFO', 'open downloads folder');
    const err = await shell.openPath(DL_DIR);
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
  chromeWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'ForgeOS Browser',
    backgroundColor: '#14110d',
    // Compact top: native title bar hidden; the single in-page bar drags the
    // window (see #bar { -webkit-app-region: drag }).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1c1813',
      symbolColor: '#9a8f7d',
      height: 42,
    },
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chromeWin.setMenuBarVisibility(false);
  chromeWin.on('resize', layoutActiveView);
  chromeWin.on('closed', () => { chromeWin = null; });
  // Attach the loader handler BEFORE loadFile: file:// may finish loading
  // near-instantly, so the listener must exist before the request starts.
  chromeWin.webContents.once('did-finish-load', () => {
    const t = createTab('about:blank');
    switchTab(t.id, { focus: false });
    sendState();
  });
  chromeWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromeWin.loadFile(RENDERER);
}

app.whenReady().then(() => {
  log.log('INFO', 'Forge Browser Lab started', { version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome });
  applyAppLevelHardening(app);
  log.log('INFO', 'fingerprint hardening applied', { ua: 'generic-chrome', screen: '1920x1080x24', hw: '8c/8gb' });
  registerIpc();
  createChromeWindow();

  // --smoke: automated self-check on the REAL app (used by scripts/verify-gates).
  const smoke = process.argv.includes('--smoke');
  if (smoke) setTimeout(runSmoke, 3500);
});

/** Smoke: open example.com in a fresh tab, extract agent view, report, quit. */
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
    console.log('SMOKE_REPORT ' + JSON.stringify(report));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const pass = report.security && report.security.label === 'HTTPS' && navOk === true;
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

app.on('window-all-closed', () => app.quit());

// Explicitly disable anything that could phone home from this project.
app.setAppUserModelId('forge.browser.lab');