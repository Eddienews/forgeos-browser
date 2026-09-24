/* session-store.test.js — crash-recovery persistence unit tests. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/engine/session-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-test-'));

function fakeTabs(urls, opts = {}) {
  const map = new Map();
  urls.forEach((u, i) => {
    map.set(i + 1, {
      url: u,
      forgetOnClose: Array.isArray(opts.forget) ? opts.forget[i] : !!opts.forget,
      restoreOnRestart: Array.isArray(opts.restore) ? opts.restore[i] : opts.restore,
    });
  });
  return map;
}

module.exports = [
  {
    name: 'named containers survive crash restore without moving URLs between jars',
    gate: 'C1',
    fn(a) {
      const tabs = new Map([
        [1, { url: 'https://example.com/a', containerId: 'work', restoreOnRestart: true }],
        [2, { url: 'https://example.com/a', containerId: 'personal', restoreOnRestart: true }],
        [3, { url: 'https://example.com/a', agentOwned: true, restoreOnRestart: false }],
        [4, { url: 'https://secret.example/', containerId: 'research', forgetOnClose: true }],
      ]);
      store.captureOpenTabs(tabs, tmp);
      a.deepStrictEqual(store.restoreTabRecords(tmp), [
        { url: 'https://example.com/a', containerId: 'work' },
        { url: 'https://example.com/a', containerId: 'personal' },
      ]);
      a.deepStrictEqual(store.restoreTabs(tmp), ['https://example.com/a', 'https://example.com/a']);
      fs.writeFileSync(path.join(tmp, 'forge-session.json'), JSON.stringify({ v: 2, tabs: [
        { url: 'https://ok.example/', containerId: 'work' },
        { url: 'file:///private', containerId: 'personal' },
        { url: 'https://no.example/', containerId: 'agent-key' },
      ] }));
      a.deepStrictEqual(store.restoreTabRecords(tmp), [{ url: 'https://ok.example/', containerId: 'work' }]);
    },
  },
  {
    name: 'capture → restore roundtrip preserves urls',
    gate: 'C1',
    fn: () => {
      const urls = ['https://a.com', 'https://b.com/x', 'https://c.com'];
      store.captureOpenTabs(fakeTabs(urls), tmp);
      const restored = store.restoreTabs(tmp);
      if (JSON.stringify(restored) !== JSON.stringify(urls)) {
        throw new Error(`expected ${urls} got ${restored}`);
      }
    },
  },
  {
    name: 'skips about:blank and file: urls',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(['about:blank', 'https://ok.com', 'file:///x']), tmp);
      const restored = store.restoreTabs(tmp);
      if (JSON.stringify(restored) !== JSON.stringify(['https://ok.com'])) {
        throw new Error(`expected only https got ${restored}`);
      }
    },
  },
  {
    name: 'skips forget-on-close tabs',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(['https://keep.com', 'https://ephemeral.com'], { forget: [false, true] }), tmp);
      const restored = store.restoreTabs(tmp);
      if (JSON.stringify(restored) !== JSON.stringify(['https://keep.com'])) {
        throw new Error(`ephemeral leaked: ${restored}`);
      }
    },
  },
  {
    name: 'skips ephemeral-mode tabs even when forget-on-close is not selected',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(
        ['https://keep.com', 'https://ephemeral.com'],
        { forget: [false, false], restore: [true, false] },
      ), tmp);
      const restored = store.restoreTabs(tmp);
      if (JSON.stringify(restored) !== JSON.stringify(['https://keep.com'])) {
        throw new Error(`ephemeral mode leaked: ${restored}`);
      }
    },
  },
  {
    name: 'dedupes repeated urls',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(['https://dup.com', 'https://dup.com', 'https://other.com']), tmp);
      const restored = store.restoreTabs(tmp);
      if (JSON.stringify(restored) !== JSON.stringify(['https://dup.com', 'https://other.com'])) {
        throw new Error(`not deduped: ${restored}`);
      }
    },
  },
  {
    name: 'caps restore at 20 tabs',
    gate: 'C1',
    fn: () => {
      const many = Array.from({ length: 40 }, (_, i) => `https://t${i}.com`);
      store.captureOpenTabs(fakeTabs(many), tmp);
      const restored = store.restoreTabs(tmp);
      if (restored.length > 20) throw new Error(`over cap: ${restored.length}`);
    },
  },
  {
    name: 'corrupt file returns empty',
    gate: 'C1',
    fn: () => {
      fs.writeFileSync(path.join(tmp, 'forge-session.json'), '{not json', 'utf8');
      const restored = store.restoreTabs(tmp);
      if (restored.length !== 0) throw new Error(`expected [] got ${restored}`);
    },
  },
  {
    name: 'clear removes saved session',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(['https://x.com']), tmp);
      store.clear(tmp);
      const restored = store.restoreTabs(tmp);
      if (restored.length !== 0) throw new Error(`clear failed: ${restored}`);
    },
  },
  {
    name: 'capturing no open tabs replaces stale recovery state atomically',
    gate: 'C1',
    fn: () => {
      store.captureOpenTabs(fakeTabs(['https://stale.example']), tmp);
      store.captureOpenTabs(new Map(), tmp);
      const restored = store.restoreTabs(tmp);
      if (restored.length !== 0) throw new Error(`stale tabs survived: ${restored}`);
      if (fs.existsSync(path.join(tmp, 'forge-session.json.tmp'))) {
        throw new Error('temporary session file was not finalized');
      }
    },
  },
];
