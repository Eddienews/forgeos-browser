/*
 * scripts/package.js — cross-platform packaging entry point.
 *
 * Builds for the HOST platform by default (win32 on Windows, darwin on Mac,
 * linux on Linux). Run `npm run package` on each target machine — cross-
 * building macOS from Windows is not supported by the toolchain (Electron
 * .app bundles need symlinks only Unix hosts create natively).
 *
 *   node scripts/package.js            host platform, host arch
 *   node scripts/package.js --all      host platform, arm64 + x64
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const hostPlatform = process.platform;            // win32 | darwin | linux
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const wantAll = process.argv.includes('--all');

const archs = wantAll ? ['x64', 'arm64'].filter(a =>
  hostPlatform !== 'win32' || a === 'x64') : [hostArch];

const IGNORES = [
  '--ignore="^/(dist|results|logs|downloads|\\.git)"',
];

for (const arch of archs) {
  const outName = `ForgeBrowserLab-${hostPlatform}-${arch}`;
  const cmd = [
    'npx electron-packager . ForgeBrowserLab',
    `--platform=${hostPlatform}`,
    `--arch=${arch}`,
    '--out=dist',
    '--overwrite',
    ...IGNORES,
  ].join(' ');
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  console.log(`OK: dist/${outName}`);
}

console.log('\nNext (optional): npm run package:portable to zip the result.');
console.log('NOTE: build ON the target OS. macOS bundles cannot be produced from Windows.');