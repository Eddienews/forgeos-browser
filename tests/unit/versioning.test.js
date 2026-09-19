'use strict';

const pkg = require('../../package.json');
const lock = require('../../package-lock.json');

module.exports = [
  {
    name: 'application and lock metadata use the same version',
    gate: 'J',
    fn(a) {
      a.strictEqual(lock.version, pkg.version);
      a.strictEqual(lock.packages[''].version, pkg.version);
    },
  },
  {
    name: 'application version is valid three-part SemVer',
    gate: 'J',
    fn(a) {
      a.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
    },
  },
  {
    name: 'Electron dependency is pinned for reproducible packages',
    gate: 'J',
    fn(a) {
      a.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/);
      a.strictEqual(lock.packages['node_modules/electron'].version, pkg.devDependencies.electron);
    },
  },
];
