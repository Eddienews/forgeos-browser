'use strict';

const fs = require('fs');
const path = require('path');
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
  {
    // Anything left inside #bar inherits its window-drag region and its
    // backdrop-filter containing block: a stray fixed element there sat over
    // the gear button and swallowed real mouse clicks.
    name: 'toolbar markup is balanced and nothing but the toolbar lives in #bar',
    gate: 'A',
    fn(a) {
      const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
      const body = html.slice(html.indexOf('<body'));
      a.strictEqual((body.match(/<div\b/g) || []).length, (body.match(/<\/div>/g) || []).length);
      let depth = 0;
      let barEnd = -1;
      for (const m of body.slice(body.indexOf('<div id="bar">')).matchAll(/<(\/?)div\b[^>]*>/g)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) { barEnd = body.indexOf('<div id="bar">') + m.index; break; }
      }
      a.ok(barEnd > 0, '#bar is closed');
      a.ok(body.indexOf('id="btn-gear"') < barEnd && body.indexOf('id="gear-menu"') < barEnd);
      a.ok(body.indexOf('id="find-bar"') > barEnd, 'find bar is a sibling of the toolbar');
      a.strictEqual(html.includes('id="plug-toast"'), false, 'the toast is created once, by ui.js');
    },
  },
];
