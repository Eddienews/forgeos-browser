'use strict';

/* Gates I/J + Phases 5/7/15/22/23 — modes, storage planning, permissions,
 * event log, fingerprint posture. */
const { MODES, describe, isValidMode } = require('../../src/engine/privacy-modes');
const { sessionPlanFor, captureTabReloadPlan, registrableHost, clearSessionData, STORAGE_TYPES, containerPartition, CONTAINER_IDS } = require('../../src/engine/storage-manager');
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
    name: 'named human containers have separate persistent sessions and reject unsafe combinations',
    gate: 'J',
    fn(a) {
      a.deepStrictEqual(CONTAINER_IDS, ['work', 'personal', 'research']);
      const partitions = CONTAINER_IDS.map(id => containerPartition(id));
      a.strictEqual(new Set(partitions).size, 3);
      for (const id of CONTAINER_IDS) {
        const plan = sessionPlanFor('https://example.com', 'standard', false, id);
        a.strictEqual(plan.partition, containerPartition(id));
        a.strictEqual(plan.ephemeral, false);
        a.strictEqual(plan.restoreOnRestart, true);
      }
      a.throws(() => containerPartition('agent-key'), /invalid container/i);
      a.throws(() => sessionPlanFor('https://example.com', 'strict', false, 'work'), /standard mode/i);
      a.throws(() => sessionPlanFor('https://example.com', 'ephemeral', false, 'work'), /standard mode/i);
      a.throws(() => sessionPlanFor('https://example.com', 'standard', true, 'work'), /forget/i);
    },
  },
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
        a.strictEqual(p.retainHistory, mode === 'strict', mode);
        a.strictEqual(p.restoreOnRestart, mode === 'strict', mode);
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
      a.strictEqual(p.retainHistory, true);
      a.strictEqual(p.restoreOnRestart, false);
    },
  },
  {
    name: 'privacy-mode reload plan preserves tab order, urls, active tab, and forget flags',
    gate: 'I',
    fn(a) {
      const tabs = new Map([
        [7, { id: 7, url: 'https://one.example', forgetOnClose: false }],
        [9, { id: 9, url: 'https://two.example', forgetOnClose: true }],
      ]);
      a.deepStrictEqual(captureTabReloadPlan(tabs, 9), {
        items: [
          { url: 'https://one.example', forgetOnClose: false },
          { url: 'https://two.example', forgetOnClose: true },
        ],
        activeIndex: 1,
      });
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
      const memory = JSON.stringify(log.recent());
      a.ok(!memory.includes('hunter2s3cret'));
      a.ok(!memory.includes('abc.def.ghi'));
      a.ok(memory.includes('<redacted>'));
    },
  },
  {
    name: 'event log control characters cannot forge additional physical records',
    gate: 'J',
    fn(a) {
      const log = new EventLog(null);
      const line = log.log('INFO\n[ALLOW]', 'message\r\nforged=1', {
        value: 'safe\u0000text\u2028tail',
      });
      a.strictEqual(line.includes('\n'), false);
      a.strictEqual(line.includes('\r'), false);
      a.ok(line.includes('\\u000a'));
      a.ok(line.includes('\\u000d'));
      a.ok(line.includes('\\u0000'));
      a.ok(line.includes('\\u2028'));
      const entry = log.recent(1)[0];
      a.strictEqual(entry.tag.includes('\n'), false);
      a.strictEqual(entry.message.includes('\r'), false);
      a.ok(entry.fields.value.includes('\\u0000'));
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
  {
    name: 'event log repairs private permissions and keeps one bounded rotation',
    gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-log-rotation-test-'));
      const file = path.join(dir, 'events.log');
      const rotated = `${file}.1`;
      try {
        fs.writeFileSync(file, '', { mode: 0o644 });
        if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
        const log = new EventLog(file, 20, { maxFileBytes: 256 });
        log.log('INFO', 'first-' + 'a'.repeat(80));
        log.log('INFO', 'second-' + 'b'.repeat(80));
        log.log('INFO', 'third-' + 'c'.repeat(80));
        a.strictEqual(fs.existsSync(rotated), true);
        a.ok(fs.statSync(file).size <= 256);
        a.ok(fs.statSync(rotated).size <= 256);
        a.ok(fs.readFileSync(rotated, 'utf8').includes('first-'));
        a.ok(fs.readFileSync(file, 'utf8').includes('third-'));
        const health = log.health();
        a.strictEqual(health.enabled, true);
        a.strictEqual(health.healthy, true);
        a.strictEqual(health.maxBytes, 256);
        a.strictEqual(health.rotated, true);
        a.strictEqual(Object.hasOwn(health, 'path'), false);
        if (process.platform !== 'win32') {
          a.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
          a.strictEqual(fs.statSync(rotated).mode & 0o777, 0o600);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'event log refuses a symbolic-link destination',
    gate: 'J',
    fn(a) {
      if (process.platform === 'win32') return;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-log-symlink-test-'));
      const target = path.join(dir, 'target.txt');
      const link = path.join(dir, 'events.log');
      try {
        fs.writeFileSync(target, 'preserve-me', { mode: 0o600 });
        fs.symlinkSync(target, link);
        const log = new EventLog(link);
        log.log('INFO', 'must not follow link');
        a.strictEqual(fs.readFileSync(target, 'utf8'), 'preserve-me');
        a.strictEqual(log.health().healthy, false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
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
