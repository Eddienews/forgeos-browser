/*
 * scripts/package.js — cross-platform packaging entry point.
 *
 * Usage:
 *   node scripts/package.js                     host platform + host arch
 *   node scripts/package.js --platform=darwin   explicit platform only
 *   node scripts/package.js --arch=arm64        explicit arch only
 *   node scripts/package.js --platform=win32,darwin,linux --arch=x64,arm64
 *
 * Cross-building macOS bundles from Windows or Linux is NOT supported
 * by the Electron toolchain (Electron.app requires a Mac). The script
 * prints a warning and skips darwin on non-darwin hosts.
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Parse --platform=... and --arch=...
const platArg = process.argv.find(a => a.startsWith('--platform='));
const archArg = process.argv.find(a => a.startsWith('--arch='));

const hostPlatform = process.platform; // win32 | darwin | linux
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';

const requestedPlatforms = platArg
  ? platArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
  : [hostPlatform];
const requestedArchs = archArg
  ? archArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
  : [hostArch];

const IGNORES = [
  '--ignore="^/(dist|results|logs|downloads|\\.git)"',
];

for (const plat of requestedPlatforms) {
  // Cross-build guard: darwin requires a darwin host
  if (plat === 'darwin' && hostPlatform !== 'darwin') {
    console.log(`SKIP: ${plat} — cannot cross-build macOS from ${hostPlatform}. Build on a Mac.`);
    continue;
  }
  for (const arch of requestedArchs) {
    // Win32 arm64 is not currently supported by electron-packager
    if (plat === 'win32' && arch === 'arm64') {
      console.log('SKIP: win32 arm64 — not supported by electron-packager.');
      continue;
    }
    const outName = `ForgeBrowserLab-${plat}-${arch}`;
    const cmd = [
      'npx electron-packager . ForgeBrowserLab',
      `--platform=${plat}`,
      `--arch=${arch}`,
      '--out=dist',
      '--overwrite',
      ...IGNORES,
    ].join(' ');
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    console.log(`OK: dist/${outName}`);
  }
}

console.log('\nNext (optional): npm run package:portable to zip the result.');
console.log('NOTE: macOS bundles cannot be produced from Windows or Linux.');