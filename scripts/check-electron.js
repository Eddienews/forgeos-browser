/*
 * scripts/check-electron.js — is the pinned Electron (and so Chromium) current?
 *
 * A browser that falls behind its engine's security releases is vulnerable no
 * matter how careful its own code is. This check fails when the pinned version
 * is behind the newest release of its own major line, or when that major line
 * is no longer one of the three Electron supports.
 *
 * Usage: node scripts/check-electron.js      (queries the npm registry)
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const SUPPORTED_MAJORS = 3; // Electron maintains the three newest stable majors.

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * @param {string} pinned     exact version from package.json
 * @param {string[]} released every published version
 * @returns {{ok: boolean, pinned: string, newestInLine: string|null, newestStable: string|null, problems: string[]}}
 */
function assessElectron(pinned, released) {
  const current = parse(pinned);
  if (!current) return { ok: false, pinned, newestInLine: null, newestStable: null,
    problems: [`package.json must pin an exact Electron version, found "${pinned}"`] };
  // Pre-releases (alpha, beta, nightly) do not parse and are ignored.
  const stable = (released || []).map(parse).filter(Boolean).sort(compare);
  if (!stable.length) return { ok: false, pinned, newestInLine: null, newestStable: null,
    problems: ['no stable Electron releases were found'] };
  const newestStable = stable[stable.length - 1];
  const line = stable.filter((v) => v[0] === current[0]);
  const newestInLine = line.length ? line[line.length - 1] : null;
  const problems = [];
  if (!newestInLine) problems.push(`Electron ${current[0]} has no stable release`);
  else if (compare(current, newestInLine) < 0)
    problems.push(`Electron ${pinned} is behind ${newestInLine.join('.')} on its own line; update to receive Chromium security fixes`);
  if (newestStable[0] - current[0] >= SUPPORTED_MAJORS)
    problems.push(`Electron ${current[0]} is no longer supported (newest stable major is ${newestStable[0]}); plan a major upgrade`);
  return { ok: problems.length === 0, pinned,
    newestInLine: newestInLine && newestInLine.join('.'), newestStable: newestStable.join('.'), problems };
}

function main() {
  const manifest = require(path.join(__dirname, '..', 'package.json'));
  const pinned = String((manifest.devDependencies || {}).electron || '');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const released = JSON.parse(execFileSync(npm, ['view', 'electron', 'versions', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' }));
  const result = assessElectron(pinned, released);
  console.log(`Electron pinned: ${result.pinned}`);
  console.log(`Newest on this line: ${result.newestInLine}`);
  console.log(`Newest stable: ${result.newestStable}`);
  for (const problem of result.problems) console.error(`STALE: ${problem}`);
  if (result.ok) console.log('Electron is current.');
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { assessElectron };
