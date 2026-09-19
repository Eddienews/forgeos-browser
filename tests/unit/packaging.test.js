'use strict';

const fs = require('fs');
const path = require('path');

const packagingSource = fs.readFileSync(
  path.join(__dirname, '../../scripts/package.js'),
  'utf8',
);

module.exports = [
  {
    name: 'packaging uses a Windows-safe Node entrypoint',
    gate: 'J',
    fn(a) {
      a.match(packagingSource, /const nodeCommand = process\.execPath/);
      a.match(packagingSource, /execFileSync\(nodeCommand, \[packagerScript, \.\.\.args\]/);
      a.doesNotMatch(packagingSource, /const npxCommand/);
    },
  },
];
