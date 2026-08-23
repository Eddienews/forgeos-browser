'use strict';

/* Gate E — Phase 6: tracking URL cleanup. Mission Test D. */
const { cleanUrl } = require('../../src/engine/url-cleaner');

module.exports = [
  {
    name: 'Test D — strips utm_source, preserves functional id',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('https://example.com/article?id=10&utm_source=test');
      a.strictEqual(r.url, 'https://example.com/article?id=10');
      a.deepStrictEqual(r.removed, ['utm_source']);
      a.strictEqual(r.changed, true);
    },
  },
  {
    name: 'spec example — utm_source=twitter stripped, id=123 kept',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('https://example.com/article?id=123&utm_source=twitter');
      a.strictEqual(r.url, 'https://example.com/article?id=123');
    },
  },
  {
    name: 'case-insensitive parameter names',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('https://example.com/a?UTM_SOURCE=x&utm_medium=y&id=1');
      a.strictEqual(r.url, 'https://example.com/a?id=1');
      a.strictEqual(r.removed.length, 2);
    },
  },
  {
    name: 'multiple tracking params + fragment preserved',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('https://example.com/x?utm_source=a&fbclid=b&gclid=c&section=2#top');
      a.strictEqual(r.url, 'https://example.com/x?section=2#top');
      a.deepStrictEqual(r.removed.sort(), ['fbclid', 'gclid', 'utm_source'].sort());
    },
  },
  {
    name: 'URL without tracking params is untouched',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('https://example.com/article?id=123&page=2');
      a.strictEqual(r.changed, false);
      a.strictEqual(r.url, 'https://example.com/article?id=123&page=2');
    },
  },
  {
    name: 'non-http(s) URLs never touched (file:, about:, data:)',
    gate: 'E',
    fn(a) {
      for (const u of ['file:///C:/x.html?utm_source=a', 'about:blank', 'data:text/html,hi?utm_source=a']) {
        a.strictEqual(cleanUrl(u).url, u, u);
      }
    },
  },
  {
    name: 'tracking parameter list is maintained separately (data file)',
    gate: 'E',
    fn(a) {
      const data = require('../../src/lists/tracking-params.json');
      a.ok(Array.isArray(data.params) && data.params.length > 40);
      a.ok(data.params.includes('utm_source') && data.params.includes('fbclid') && data.params.includes('gclid'));
      a.strictEqual(data.maintained_separately, true);
    },
  },
  {
    name: 'malformed URL returns unchanged',
    gate: 'E',
    fn(a) {
      const r = cleanUrl('http://[invalid');
      a.strictEqual(r.changed, false);
    },
  },
];