'use strict';

/* Gate J — YouTube plugin command, lifecycle, and output handling. */
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PluginRunner } = require('../../src/ext/plugins');
const {
  buildYtDlpArgs,
  classifyYtDlpError,
  extractVideoId,
  parseYtDlpProgress,
  resolveExecutable,
  vttToPlainTextContent,
} = require('../../src/ext/ytdlp-tools');

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIDEO_ID = 'dQw4w9WgXcQ';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ytdlp-test-'));
}

function runnerFor(dir, child, overrides = {}) {
  return new PluginRunner({
    log: { log: () => {} },
    downloadsDir: dir,
    settingsImpl: { all: () => ({ subtitleLangs: 'en.*,pt.*' }) },
    resolveToolchainImpl: () => ({
      ytdlp: '/tools/yt-dlp',
      ffmpeg: '/tools/ffmpeg',
      jsRuntime: { name: 'node', path: '/tools/node' },
    }),
    spawnImpl: () => child,
    ...overrides,
  });
}

function terminalPromise(events) {
  return new Promise((resolve) => {
    events.onTerminal = resolve;
  });
}

function emitterFor(events) {
  return (event) => {
    events.push(event);
    if (['done', 'error', 'cancelled'].includes(event.state) && events.onTerminal) events.onTerminal(event);
  };
}

module.exports = [
  {
    name: 'YouTube URL parsing accepts supported forms and rejects lookalike hosts',
    gate: 'J',
    fn(a) {
      a.strictEqual(extractVideoId(VIDEO_URL), VIDEO_ID);
      a.strictEqual(extractVideoId(`https://youtu.be/${VIDEO_ID}?t=1`), VIDEO_ID);
      a.strictEqual(extractVideoId(`https://m.youtube.com/shorts/${VIDEO_ID}`), VIDEO_ID);
      a.strictEqual(extractVideoId(`https://youtube.com/live/${VIDEO_ID}`), VIDEO_ID);
      a.strictEqual(extractVideoId(`https://notyoutube.com/watch?v=${VIDEO_ID}`), null);
      a.strictEqual(extractVideoId('https://youtube.com/watch?v=bad'), null);
    },
  },
  {
    name: 'executable discovery resolves a real PATH file and rejects a stale override',
    gate: 'J',
    fn(a) {
      const dir = tempDir();
      try {
        const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const executable = path.join(dir, name);
        fs.writeFileSync(executable, '#!/bin/sh\n', 'utf8');
        fs.chmodSync(executable, 0o755);
        const options = { env: { PATH: dir }, homedir: dir, execPath: null, resourcesPath: null };
        a.strictEqual(resolveExecutable('yt-dlp', options), executable);
        a.strictEqual(resolveExecutable('yt-dlp', { ...options, override: path.join(dir, 'missing') }), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'video command is shell-free and strictly selects QuickTime-compatible codecs',
    gate: 'J',
    fn(a) {
      const args = buildYtDlpArgs('video', VIDEO_URL, {
        ffmpeg: '/tools/ffmpeg',
        jsRuntime: { name: 'node', path: '/tools/node' },
      });
      const format = args[args.indexOf('--format') + 1];
      a.ok(format.startsWith('bv[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]'));
      a.ok(format.includes('b[height<=1080][vcodec^=avc1][acodec^=mp4a]'));
      a.strictEqual(/av01|vp0?9|opus|bv\*/.test(format), false);
      a.ok(args.includes('after_move:FORGE_OUTPUT:%(filepath)s'));
      a.match(args[args.indexOf('--progress-template') + 1], /_speed_str.*_eta_str.*_total_bytes_str/);
      a.deepStrictEqual(args.slice(-2), ['--', VIDEO_URL]);
      a.ok(args.includes('node:/tools/node'));
    },
  },
  {
    name: 'yt-dlp progress includes percentage, speed, ETA, and total size',
    gate: 'J',
    fn(a) {
      a.deepStrictEqual(
        parseYtDlpProgress('FORGE_PROGRESS: 42.5%|3.20MiB/s|00:18|120.0MiB'),
        { pct: 42.5, speed: '3.20MiB/s', eta: '00:18', total: '120.0MiB' }
      );
      a.deepStrictEqual(
        parseYtDlpProgress('FORGE_PROGRESS:100%|N/A|NA|unknown'),
        { pct: 100, speed: null, eta: null, total: null }
      );
      a.strictEqual(parseYtDlpProgress('ordinary output'), null);
    },
  },
  {
    name: 'transcript command requests manual and automatic VTT captions with safe languages',
    gate: 'J',
    fn(a) {
      const args = buildYtDlpArgs('transcript', VIDEO_URL, {
        subtitleLangs: '--exec=bad',
        ffmpeg: '/tools/ffmpeg',
        jsRuntime: { name: 'node', path: '/tools/node' },
      });
      a.ok(args.includes('--write-auto-subs'));
      a.ok(args.includes('--write-subs'));
      a.strictEqual(args[args.indexOf('--sub-langs') + 1], 'en.*,pt.*');
      a.strictEqual(args[args.indexOf('--sub-format') + 1], 'vtt/best');
      a.deepStrictEqual(args.slice(-2), ['--', VIDEO_URL]);
    },
  },
  {
    name: 'VTT conversion removes timestamps, markup, and rolling-caption duplicates',
    gate: 'J',
    fn(a) {
      const raw = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>Hello</c>\n\n00:00:01.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:03.000\nworld &amp; friends\n`;
      a.strictEqual(vttToPlainTextContent(raw), 'Hello world & friends\n');
    },
  },
  {
    name: 'yt-dlp failures become actionable user messages',
    gate: 'J',
    fn(a) {
      a.match(classifyYtDlpError('ERROR: No subtitles for the requested languages', 1, { subtitleLangs: 'pt.*' }), /No subtitles/);
      a.match(classifyYtDlpError('WARNING: No supported JavaScript runtime could be found', 1), /Node 22\+/);
      a.match(classifyYtDlpError('ERROR: Sign in to confirm you are not a bot', 1), /sign-in|bot check/i);
      a.match(classifyYtDlpError('ERROR: Requested format is not available', 1), /QuickTime-compatible/);
      a.strictEqual(classifyYtDlpError('ERROR: private video', 1), 'private video');
    },
  },
  {
    name: 'denial happens before tool discovery or process launch',
    gate: 'J',
    async fn(a) {
      let resolved = false;
      let spawned = false;
      const runner = new PluginRunner({
        log: { log: () => {} },
        resolveToolchainImpl: () => { resolved = true; return {}; },
        spawnImpl: () => { spawned = true; return fakeChild(); },
      });
      const result = await runner.run('video', VIDEO_URL, async () => ({ approved: false }));
      a.strictEqual(result.state, 'denied');
      a.strictEqual(resolved, false);
      a.strictEqual(spawned, false);
    },
  },
  {
    name: 'approved action reports a missing yt-dlp without attempting spawn',
    gate: 'J',
    async fn(a) {
      let spawned = false;
      const runner = new PluginRunner({
        log: { log: () => {} },
        resolveToolchainImpl: () => ({ ytdlp: null, ffmpeg: null, jsRuntime: null }),
        spawnImpl: () => { spawned = true; return fakeChild(); },
      });
      const result = await runner.run('video', VIDEO_URL, async () => ({ approved: true }));
      a.strictEqual(result.state, 'error');
      a.match(result.error, /not installed/);
      a.strictEqual(spawned, false);
    },
  },
  {
    name: 'video lifecycle propagates progress and validates the playable output file',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const child = fakeChild();
        let spawnCall = null;
        const runner = runnerFor(dir, child, {
          spawnImpl: (command, args, options) => { spawnCall = { command, args, options }; return child; },
        });
        const events = [];
        const terminal = terminalPromise(events);
        const started = await runner.run('video', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        const output = path.join(dir, `Demo [${VIDEO_ID}].mp4`);
        fs.writeFileSync(output, 'video-bytes');
        child.stdout.write(`FORGE_PROGRESS: 42.5%\nFORGE_OUTPUT:${output}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
        const done = await terminal;
        a.strictEqual(started.state, 'started');
        a.strictEqual(spawnCall.options.shell, false);
        a.strictEqual(spawnCall.options.cwd, dir);
        a.ok(events.some((event) => event.state === 'progress' && event.pct === 42.5));
        a.strictEqual(done.state, 'done');
        a.deepStrictEqual(done.files, [output]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'transcript lifecycle keeps timestamped VTT and readable text outputs',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const child = fakeChild();
        const runner = runnerFor(dir, child);
        const events = [];
        const terminal = terminalPromise(events);
        await runner.run('transcript', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        const vtt = path.join(dir, `Demo [${VIDEO_ID}].en.vtt`);
        fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello ForgeOS\n', 'utf8');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
        const done = await terminal;
        const txt = vtt.replace(/\.vtt$/, '.txt');
        a.strictEqual(done.state, 'done');
        a.ok(done.files.includes(txt));
        a.ok(done.files.includes(vtt));
        a.strictEqual(fs.readFileSync(txt, 'utf8'), 'Hello ForgeOS\n');
        a.strictEqual(fs.existsSync(vtt), true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'successful yt-dlp exit without captions is surfaced as an error',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const child = fakeChild();
        const runner = runnerFor(dir, child);
        const events = [];
        const terminal = terminalPromise(events);
        await runner.run('transcript', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
        const result = await terminal;
        a.strictEqual(result.state, 'error');
        a.match(result.error, /No subtitles were produced/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'partial caption failure preserves and converts subtitles already downloaded',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const child = fakeChild();
        const runner = runnerFor(dir, child);
        const events = [];
        const terminal = terminalPromise(events);
        await runner.run('transcript', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        const vtt = path.join(dir, `Demo [${VIDEO_ID}].en.vtt`);
        fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial success\n', 'utf8');
        child.stderr.write('ERROR: Unable to download one requested translated subtitle\n');
        child.stderr.end();
        child.stdout.end();
        child.emit('close', 1, null);
        const result = await terminal;
        a.strictEqual(result.state, 'done');
        a.ok(result.warning);
        a.strictEqual(fs.readFileSync(vtt.replace(/\.vtt$/, '.txt'), 'utf8'), 'Partial success\n');
        a.ok(result.files.includes(vtt));
        a.strictEqual(fs.existsSync(vtt), true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'failed caption job does not claim an unrelated stale VTT as new output',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const stale = path.join(dir, `Old [${VIDEO_ID}].en.vtt`);
        fs.writeFileSync(stale, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOld caption\n', 'utf8');
        const child = fakeChild();
        const runner = runnerFor(dir, child);
        const events = [];
        const terminal = terminalPromise(events);
        await runner.run('transcript', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        child.stderr.write('ERROR: Unable to download requested subtitles\n');
        child.stderr.end();
        child.stdout.end();
        child.emit('close', 1, null);
        const result = await terminal;
        a.strictEqual(result.state, 'error');
        a.strictEqual(fs.existsSync(stale.replace(/\.vtt$/, '.txt')), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'cancellation terminates the job and emits one cancelled terminal event',
    gate: 'J',
    async fn(a) {
      const dir = tempDir();
      try {
        const child = fakeChild();
        const runner = runnerFor(dir, child);
        const events = [];
        const terminal = terminalPromise(events);
        const started = await runner.run('video', VIDEO_URL, async () => ({ approved: true }), emitterFor(events));
        a.strictEqual(runner.cancel(started.jobId), true);
        child.emit('close', null, 'SIGTERM');
        const result = await terminal;
        a.strictEqual(child.killed, true);
        a.strictEqual(result.state, 'cancelled');
        a.strictEqual(events.filter((event) => ['done', 'error', 'cancelled'].includes(event.state)).length, 1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
