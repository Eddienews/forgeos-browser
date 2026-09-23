'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

let answer = 0;
let prompts = 0;
const originalLoad = Module._load;
let SessionAdapter;
try {
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { dialog: { showMessageBoxSync() { prompts++; return answer; } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ SessionAdapter } = require('../../src/ext/electron-adapter'));
} finally {
  Module._load = originalLoad;
}

function fixture(dir, window) {
  const session = new EventEmitter();
  session.webRequest = {
    onBeforeSendHeaders() {}, onBeforeRequest() {}, onHeadersReceived() {},
  };
  session.setPermissionRequestHandler = () => {};
  const records = [];
  const log = { log() {} };
  const adapter = new SessionAdapter({ session, engine: {}, log, modeId: 'standard',
    getChromeWindow: () => window, downloadsDir: dir, onDownloadRecord: r => records.push(r) });
  adapter.install();
  return { session, adapter, records };
}
function item(filename = 'report.txt') {
  const value = new EventEmitter();
  value.getURL = () => 'https://example.test/report';
  value.getFilename = () => filename;
  value.getReceivedBytes = () => 0;
  value.getTotalBytes = () => 10;
  value.getMimeType = () => 'text/plain';
  value.setSavePath = p => { value.saved = p; };
  value.cancel = () => { value.cancelled = true; };
  return value;
}

module.exports = [
  {
    name: 'website download is denied without explicit human approval', gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-dl-test-'));
      try {
        prompts = 0; answer = 0;
        const f = fixture(dir, {});
        const download = item();
        f.session.emit('will-download', {}, download);
        a.strictEqual(download.cancelled, true);
        a.strictEqual(download.saved, undefined);
        a.strictEqual(prompts, 1);
        a.strictEqual(f.records.length, 0);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'approved downloads use fresh paths despite existing or concurrent names', gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-dl-test-'));
      try {
        const old = path.join(dir, 'report.txt');
        fs.writeFileSync(old, 'original');
        answer = 1; prompts = 0;
        const f = fixture(dir, {});
        const first = item();
        f.session.emit('will-download', {}, first);
        const second = item();
        f.session.emit('will-download', {}, second);
        a.ok(first.saved && second.saved && first.saved !== second.saved);
        a.strictEqual(fs.readFileSync(old, 'utf8'), 'original');
        a.strictEqual(prompts, 2);
        a.strictEqual(f.records[0].path, first.saved);
        a.strictEqual(f.records[1].path, second.saved);
        a.strictEqual(fs.lstatSync(path.dirname(first.saved)).isDirectory(), true);
        a.notStrictEqual(path.dirname(first.saved), dir);
        a.strictEqual(fs.existsSync(first.saved), false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'no approval window cancels rather than silently downloading', gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-dl-test-'));
      try {
        const f = fixture(dir, null);
        const download = item();
        f.session.emit('will-download', {}, download);
        a.strictEqual(download.cancelled, true);
        a.strictEqual(download.saved, undefined);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'symlinked download root is refused even after approval', gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-dl-test-'));
      try {
        const target = path.join(dir, 'target');
        const link = path.join(dir, 'downloads');
        fs.mkdirSync(target);
        fs.symlinkSync(target, link, 'junction');
        answer = 1;
        const f = fixture(link, {});
        const download = item();
        f.session.emit('will-download', {}, download);
        a.strictEqual(download.cancelled, true);
        a.strictEqual(download.saved, undefined);
        a.deepStrictEqual(fs.readdirSync(target), []);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'save path failure cancels rather than falling back to Chromium defaults', gate: 'J',
    fn(a) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-dl-test-'));
      try {
        answer = 1;
        const f = fixture(dir, {});
        const download = item();
        download.setSavePath = () => { throw new Error('cannot save'); };
        f.session.emit('will-download', {}, download);
        a.strictEqual(download.cancelled, true);
        a.strictEqual(f.records.length, 0);
        a.deepStrictEqual(fs.readdirSync(dir), []);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
];
