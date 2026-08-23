'use strict';

/* Gates I/J + Phases 5/7/15/22/23 — modes, storage planning, permissions,
 * event log, fingerprint posture. */
const { MODES, describe, isValidMode } = require('../../src/engine/privacy-modes');
const { sessionPlanFor, registrableHost, clearSessionData, STORAGE_TYPES } = require('../../src/engine/storage-manager');
const { permissionFor, PERMISSION_DEFAULTS, EXPOSURE_MAP } = require('../../src/engine/fingerprint');
const { EventLog } = require('../../src/engine/event-log');
const os = require('os');
const path = require('path');
const fs = require('fs');

module.exports = [
  /* ---- Phase 22: privacy modes ---- */
  {
    name: 'three modes exist and are not described as anonymity',
    gate: 'I',
    fn(a) {
      a.strictEqual(isValidMode('standard'), true);
      a.strictEqual(isValidMode('strict'), true);
      a.strictEqual(isValidMode('ephemeral'), true);
      a.strictEqual(isValidMode('nope'), false);
      a.ok(/not anonymous/i.test(describe('ephemeral')));
      a.ok(!/anonym/i.test(MODES.standard.summary));
    },
  },
  {
    name: 'mode flags match the spec matrix',
    gate: 'I',
    fn(a) {
      a.strictEqual(MODES.standard.blockThirdPartyCookies, true);
      a.strictEqual(MODES.standard.blockPersistentCookies, false);
      a.strictEqual(MODES.strict.blockPersistentCookies, true);
      a.strictEqual(MODES.strict.restrictThirdPartyResources, true);
      a.strictEqual(MODES.ephemeral.ephemeral, true);
      a.strictEqual(MODES.ephemeral.retainHistory, false);
    },
  },
  /* ---- Phase 5: storage isolation ---- */
  {
    name: 'standard mode uses the normal (shared) session — no partitions',
    gate: 'I',
    fn(a) {
      const p = sessionPlanFor('https://example.com', 'standard', false);
      a.strictEqual(p.partition, null);
      a.strictEqual(p.dedicated, false);
    },
  },
  {
    name: 'strict & ephemeral use dedicated NEVER-persisted per-tab partitions',
    gate: 'J',
    fn(a) {
      for (const mode of ['strict', 'ephemeral']) {
        const p = sessionPlanFor('https://example.com', mode, false);
        a.ok(p.partition && p.partition.startsWith('forge-tab-'), mode);
        a.strictEqual(p.ephemeral, true, mode);
      }
    },
  },
  {
    name: '"forget this site when closed" forces a dedicated ephemeral partition',
    gate: 'J',
    fn(a) {
      const p = sessionPlanFor('https://example.com', 'standard', true);
      a.strictEqual(p.dedicated, true);
      a.strictEqual(p.ephemeral, true);
    },
  },
  {
    name: 'registrableHost collapses subdomains for isolation keys',
    gate: 'J',
    fn(a) {
      a.strictEqual(registrableHost('https://a.b.example.com/x'), 'example.com');
      a.strictEqual(registrableHost('https://127.0.0.1/'), '127.0.0.1');
      a.strictEqual(registrableHost('localhost'), 'localhost');
    },
  },
  {
    name: 'clearSessionData is safe on a null session (no-op)',
    gate: 'J',
    fn(a) {
      return clearSessionData(null).then((n) => { a.strictEqual(n, 0); });
    },
  },
  {
    name: 'storage types enumerated (cookies, localstorage, indexdb, caches, sw)',
    gate: 'J',
    fn(a) {
      for (const t of ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers']) {
        a.ok(STORAGE_TYPES.includes(t), t);
      }
    },
  },
  /* ---- Phase 7/15: fingerprint & permissions ---- */
  {
    name: 'permission defaults: sensors ASK, unknown DENY, nothing silent',
    gate: 'I',
    fn(a) {
      for (const p of ['geolocation', 'camera', 'microphone', 'notifications', 'clipboard-read', 'persistent-storage']) {
        a.strictEqual(PERMISSION_DEFAULTS[p], 'ASK', p);
      }
      a.strictEqual(PERMISSION_DEFAULTS.unknown, 'DENY');
    },
  },
  {
    name: 'strict/ephemeral downgrade ASK → DENY for sensor permissions',
    gate: 'I',
    fn(a) {
      a.strictEqual(permissionFor('geolocation', 'standard'), 'ASK');
      a.strictEqual(permissionFor('geolocation', 'strict'), 'DENY');
      a.strictEqual(permissionFor('camera', 'ephemeral'), 'DENY');
      a.strictEqual(permissionFor('fullscreen', 'strict'), 'ALLOW'); // safe UIs keep working
    },
  },
  {
    name: 'fingerprint exposure map documents every channel honestly',
    gate: 'I',
    fn(a) {
      const channels = EXPOSURE_MAP.map((e) => e.channel);
      for (const c of ['Canvas', 'WebGL', 'Fonts', 'Screen', 'Timezone', 'Language', 'Audio', 'Hardware', 'Navigator']) {
        a.ok(channels.includes(c), c);
      }
    },
  },
  /* ---- Phase 23: event log ---- */
  {
    name: 'event log records tag, message and sanitized fields',
    gate: 'J',
    fn(a) {
      const log = new EventLog(null);
      log.log('BLOCK', 'tracker request', { url: 'https://ad.doubleclick.net/x' });
      log.log('ASK', 'agent requested action', { action: 'SUBMIT_FORM' });
      const entries = log.recent(10);
      a.strictEqual(entries.length, 2);
      a.deepStrictEqual(log.counts(), { BLOCK: 1, ASK: 1 });
    },
  },
  {
    name: 'sensitive values never enter the log (password= and token= redacted)',
    gate: 'J',
    fn(a) {
      const log = new EventLog(null);
      const line = log.log('DENY', 'blocked', { field: 'password=hunter2s3cret', auth: 'token=abc.def.ghi' });
      a.ok(!line.includes('hunter2s3cret'));
      a.ok(!line.includes('abc.def.ghi'));
      a.ok(line.includes('<redacted>'));
    },
  },
  {
    name: 'event log appends locally to a file without network',
    gate: 'J',
    fn(a) {
      const tmp = path.join(os.tmpdir(), 'forge-log-test-' + Date.now() + '.log');
      try {
        const log = new EventLog(tmp);
        log.log('CLEAN', 'tracking parameter', { param: 'utm_source' });
        const content = fs.readFileSync(tmp, 'utf8');
        a.ok(content.includes('[CLEAN]'));
        a.ok(content.includes('utm_source'));
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    },
  },
  /* ---- No-telemetry posture (Phase 24) ---- */
  {
    name: 'no source code references analytics/telemetry hosts or SDKs (Phase 24)',
    gate: 'J',
    fn(a) {
      const srcDir = path.join(__dirname, '..', '..', 'src');
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
      const files = walk(srcDir).filter((f) => f.endsWith('.js'));
      // Live references only: an SDK require/import, or a URL that resolves
      // to a telemetry host. The classifier legitimately NAMES tracker
      // keywords and list files hold hostname data — those are data, not
      // outbound calls, and are excluded by this pattern.
      const liveRe = /(require\(['"][^'"]*(posthog|mixpanel|@?sentry)|import\s+.*(posthog|mixpanel|sentry)|https?:\/\/[^'"\s]*(posthog\.com|mixpanel\.com|sentry\.io|google-analytics\.com|googletagmanager\.com|doubleclick\.net|scorecardresearch\.com))/i;
      const offenders = files.filter((f) => liveRe.test(fs.readFileSync(f, 'utf8')));
      a.deepStrictEqual(offenders, []);
      // And nothing ever calls navigator.sendBeacon / telemetry endpoints.
      const beacon = files.filter((f) => /sendBeacon|navigator\.sendBeacon/i.test(fs.readFileSync(f, 'utf8')));
      a.deepStrictEqual(beacon, []);
    },
  },
];