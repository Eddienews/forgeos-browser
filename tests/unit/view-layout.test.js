'use strict';

const { browserViewBounds } = require('../../src/engine/view-layout');

module.exports = [
  {
    name: 'browser page keeps full height and reserves a settings column',
    gate: 'A',
    fn(a) {
      a.deepStrictEqual(browserViewBounds({
        width: 1200, height: 800, toolbarHeight: 42, rightInset: 320,
      }), { x: 0, y: 42, width: 880, height: 758 });
    },
  },
  {
    name: 'settings reservation preserves a usable minimum page width',
    gate: 'A',
    fn(a) {
      a.deepStrictEqual(browserViewBounds({
        width: 760, height: 520, toolbarHeight: 42, rightInset: 700,
      }), { x: 0, y: 42, width: 320, height: 478 });
    },
  },
];
