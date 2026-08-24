/*
 * electron-adapter.js — Phase 2/3/4/13/15 runtime wiring for one session.
 *
 * Attaches the pure engine to an Electron session:
 *  - onBeforeRequest  → classify + policy → cancel (BLOCK) or redirectURL
 *                       (tracking-parameter cleanup on navigations)
 *  - onHeadersReceived → Set-Cookie policy (third-party / tracking /
 *                       persistent-by-mode cookies stripped)
 *  - setPermissionRequestHandler → Phase 15 defaults, ASK via dialog
 *  - will-download    → Phase 13 laboratory directory + metadata, never
 *                       auto-executed
 *
 * Handlers are installed once per session; counters are session-scoped.
 * Per-tab "this page" counts are the session delta across a navigation
 * (see main.js).
 */
'use strict';

const path = require('path');
const { dialog } = require('electron');

const { decideRequest } = require('../engine/network-policy');
const { filterSetCookieHeaders } = require('../engine/cookie-policy');
const { cleanUrl } = require('../engine/url-cleaner');
const { permissionFor } = require('../engine/fingerprint');
const { MODES } = require('../engine/privacy-modes');
const settings = require('../engine/settings');

const DOWNLOADS_DIR = path.join(path.dirname(path.dirname(__dirname)), 'downloads');

/** Sanitize a download filename: no path separators, dots, or control chars. */
function safeFileName(name) {
  const base = String(name || 'download')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return base || 'download';
}

const EXECUTABLE_RE = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|jar|apk|dmg|sh|bin|pif|reg|cer|iso|svg)$/i;

class SessionAdapter {
  /**
   * @param {object} opts
   *  - session (Electron session)
   *  - engine (FilterEngine)
   *  - log (EventLog)
   *  - modeId
   *  - getChromeWindow: () => BrowserWindow (for approval dialogs)
   *  - onDownloadRecord: (record) => void
   *  - onBlock: maybe optional callback
   */
  constructor(opts) {
    this.session = opts.session;
    this.engine = opts.engine;
    this.log = opts.log;
    this.modeId = opts.modeId;
    this.getChromeWindow = opts.getChromeWindow || (() => null);
    this.onDownloadRecord = opts.onDownloadRecord || (() => {});
    this.counters = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0, allowed: 0 };
    this.snapshot = { ...this.counters };
    this.installed = false;
  }

  install() {
    if (this.installed) return;
    const { session, engine, log } = this;
    const self = this;

    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const url = details.url;
      const tabUrl = details.referrer || (details.resourceType === 'mainFrame' ? url : url);
      const resourceType = details.resourceType || 'other';
      const S = settings.all();

      // Phase 6: strip tracking parameters on main-frame navigations.
      if (resourceType === 'mainFrame') {
        if (S.stripTrackingParams !== false) {
          const cleaned = cleanUrl(url);
          if (cleaned.changed) {
            self.counters.params += cleaned.removed.length;
            log.log('CLEAN', 'tracking parameter removed', { url, removed: cleaned.removed.join(','), to: cleaned.url });
            callback({ redirectURL: cleaned.url });
            return;
          }
        }
      }

      // User toggle: ad/tracker blocking off → only classify for counters.
      const blockingEnabled = S.blockAds !== false;

      const decision = decideRequest({ url, tabUrl, resourceType, engine, modeId: self.modeId });
      const wouldBlock = decision.decision === 'BLOCK';
      // If user disabled blocking, still block hard categories? No — respect
      // the toggle fully; log as ALLOW-with-note so the dashboard stays honest.
      if (wouldBlock && !blockingEnabled) {
        self.counters.allowed++;
        callback({});
        return;
      }
      if (wouldBlock) {
        const cat = decision.category;
        if (cat === 'ADVERTISING') self.counters.ads++;
        else if (cat === 'TRACKING') self.counters.trackers++;
        else if (cat === 'ANALYTICS') self.counters.analytics++;
        else if (cat === 'THIRD_PARTY') self.counters.thirdParty++;
        log.log('BLOCK', `${decision.reason} request blocked`, {
          url, category: cat, tab: tabUrl.slice(0, 200), type: resourceType,
        });
        callback({ cancel: true });
        return;
      }
      self.counters.allowed++;
      callback({});
    });

    session.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const responseHeaders = details.responseHeaders || {};
      const S = settings.all();
      if (S.blockThirdPartyCookies === false) {
        // User allowed third-party cookies: pass headers through untouched.
        callback({ responseHeaders });
        return;
      }
      const res = filterSetCookieHeaders(responseHeaders, {
        requestUrl: details.url,
        tabUrl: details.referrer || details.url,
        modeId: self.modeId,
      });
      if (res.blocked.length) {
        self.counters.cookies += res.blocked.length;
        for (const b of res.blocked) {
          log.log('BLOCK', `${b.reason} cookie`, { name: b.name, from: details.url.slice(0, 200) });
        }
      }
      callback({ responseHeaders: res.headers });
    });

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (!permission) { callback(false); return; }
      const decision = permissionFor(permission, self.modeId);
      if (decision === 'DENY') {
        log.log('DENY', 'permission denied', { permission, from: details.requestingUrl || '' });
        callback(false);
        return;
      }
      if (decision === 'ASK') {
        const win = self.getChromeWindow();
        if (win) {
          const r = dialog.showMessageBoxSync(win, {
            type: 'question',
            title: 'Forge Browser Lab — permission request',
            message: `“${permission}” permission requested by ${details.requestingUrl || 'a page'}`,
            detail: 'Granting exposes this capability to the website. Recommendation: Deny unless you trust the site.',
            buttons: ['Deny', 'Allow'],
            defaultId: 0,
            cancelId: 0,
          });
          log.log(r.response === 0 ? 'DENY' : 'ALLOW', `${permission} permission ${r.response === 0 ? 'denied' : 'granted'}`, {
            permission, from: details.requestingUrl || '',
          });
          callback(r.response === 1);
          return;
        }
        callback(false); // no window to ask — fail closed
        return;
      }
      callback(true);
    });

    session.on('will-download', (event, item) => {
      const url = item.getURL();
      let origin = '';
      try { origin = new URL(url).hostname; } catch {}
      const filename = safeFileName(item.getFilename());
      const savePath = path.join(DOWNLOADS_DIR, filename);
      item.setSavePath(savePath);
      item.once('done', (_e, state) => {
        const record = {
          filename,
          source_domain: origin,
          size: item.getReceivedBytes(),
          content_type: item.getMimeType() || '',
          time: new Date().toISOString(),
          state,
          path: savePath,
          executable: EXECUTABLE_RE.test(filename),
        };
        const tag = state === 'completed' ? 'INFO' : 'ERROR';
        log.log(tag, `download ${state}`, {
          filename, source: origin, size: record.size,
          content_type: record.content_type || 'unknown',
          executable: record.executable ? 'YES' : 'no',
        });
        self.onDownloadRecord(record);
      });
    });

    this.installed = true;
  }

  setMode(modeId) { this.modeId = modeId; }

  resetCounters() { this.counters = { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0, allowed: 0 }; }

  /** Per-page delta since last taken snapshot. */
  takeDelta() {
    const now = { ...this.counters };
    const delta = {
      ads: now.ads - this.snapshot.ads,
      trackers: now.trackers - this.snapshot.trackers,
      analytics: now.analytics - this.snapshot.analytics,
      thirdParty: now.thirdParty - this.snapshot.thirdParty,
      params: now.params - this.snapshot.params,
      cookies: now.cookies - this.snapshot.cookies,
    };
    this.snapshot = now;
    return delta;
  }
}

module.exports = { SessionAdapter, safeFileName, EXECUTABLE_RE, DOWNLOADS_DIR };