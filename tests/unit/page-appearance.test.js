'use strict';

const { DARK_SCROLLBAR_CSS, supportsPageAppearance } = require('../../src/engine/page-appearance');

module.exports = [
  {
    name: 'dark page scrollbar styling is limited to web pages',
    gate: 'A',
    fn(a) {
      a.strictEqual(supportsPageAppearance('https://example.com'), true);
      a.strictEqual(supportsPageAppearance('http://localhost:3000'), true);
      a.strictEqual(supportsPageAppearance('file:///tmp/example.html'), false);
      a.strictEqual(supportsPageAppearance('not a url'), false);
    },
  },
  {
    name: 'page scrollbar uses the ForgeOS dark translucent palette',
    gate: 'A',
    fn(a) {
      a.match(DARK_SCROLLBAR_CSS, /::-webkit-scrollbar-track/);
      a.match(DARK_SCROLLBAR_CSS, /rgba\(18, 16, 13, 0\.82\)/);
      a.match(DARK_SCROLLBAR_CSS, /css|background/i);
    },
  },
];
