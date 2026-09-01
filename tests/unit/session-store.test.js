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
    });
  });
  return map;
}

module.exports = [
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
    name: 'skips ephemeral (forgetOnClose) tabs',
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
];
