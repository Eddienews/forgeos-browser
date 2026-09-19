'use strict';

const path = require('path');
const { isExistingPathInside, isPathInside, progressPercent, upsertDownload } = require('../../src/engine/download-center');

module.exports = [
  {
    name: 'download records update by id without duplicate rows',
    gate: 'J',
    fn(a) {
      const list = [];
      upsertDownload(list, { id: 'job-1', state: 'running', pct: 10 });
      upsertDownload(list, { id: 'job-1', state: 'running', pct: 55 });
      a.strictEqual(list.length, 1);
      a.strictEqual(list[0].pct, 55);
      a.ok(list[0].time);
    },
  },
  {
    name: 'download progress is bounded and handles unknown totals',
    gate: 'J',
    fn(a) {
      a.strictEqual(progressPercent(50, 100), 50);
      a.strictEqual(progressPercent(200, 100), 100);
      a.strictEqual(progressPercent(1, 0), null);
    },
  },
  {
    name: 'download file actions stay inside the managed directory',
    gate: 'K',
    fn(a) {
      const base = path.resolve('/managed/downloads');
      a.strictEqual(isPathInside(base, path.join(base, 'video.mp4')), true);
      a.strictEqual(isPathInside(base, path.resolve(base, '..', 'secret.txt')), false);
      a.strictEqual(isPathInside(base, base), false);
      const escapedSymlink = {
        realpathSync(value) {
          return value === base ? base : path.resolve(base, '..', 'secret.txt');
        },
      };
      a.strictEqual(isExistingPathInside(base, path.join(base, 'link.txt'), escapedSymlink), false);
    },
  },
];
