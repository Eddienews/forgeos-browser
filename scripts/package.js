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

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { PACKAGE_FILES, PACKAGE_IGNORE_SOURCE } = require('./package-policy');

const ROOT = path.join(__dirname, '..');
const manifest = require(path.join(ROOT, 'package.json'));
const electronVersion = String(manifest.devDependencies && manifest.devDependencies.electron || '').replace(/^[^0-9]*/, '');

if (!/^\d+\.\d+\.\d+/.test(electronVersion)) {
  throw new Error('package.json must declare a concrete Electron version');
}

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

// Invoke the installed packager through the current Node executable instead
// of spawning `npx.cmd` on Windows. Windows treats .cmd shims as shell
// scripts, and child_process.execFileSync cannot launch that shim reliably
// (it returns EINVAL on the hosted runner). Calling the real ESM entrypoint
// keeps the packaging command identical across Windows, macOS, and Linux.
const nodeCommand = process.execPath;
const packagerScript = path.join(
  ROOT,
  'node_modules',
  '@electron',
  'packager',
  'bin',
  'electron-packager.mjs',
);

function printableArgument(value) {
  return /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function verifyPackageArchive(archivePath, sourceRoot = ROOT) {
  if (!fs.existsSync(archivePath)) throw new Error(`Missing app.asar: ${archivePath}`);
  // Inspect the *written* archive; a path filter alone does not prove what
  // packager emitted. listPackage includes directories, so check every leaf.
  const members = asar.listPackage(archivePath);
  const normalizeMember = member => member.replace(/\\/g, '/').replace(/^\/+/, '');
  const leaves = members.filter(member => !asar.statFile(archivePath, member.replace(/^[\\/]+/, ''), false).files)
    .map(normalizeMember).sort();
  const approved = new Set(PACKAGE_FILES);
  const unexpected = leaves.filter(member => !approved.has(member));
  const missing = PACKAGE_FILES.filter(member => !leaves.includes(member));
  if (unexpected.length || missing.length || leaves.length !== new Set(leaves).size) {
    throw new Error(`Unapproved app.asar inventory: unexpected=${JSON.stringify(unexpected)} missing=${JSON.stringify(missing)}`);
  }
  for (const member of leaves) {
    const actual = asar.extractFile(archivePath, path.join(...member.split('/')));
    let expected;
    if (member === 'package.json') {
      // electron-packager's prune step removes exactly these development-only
      // top-level fields and serializes the remaining manifest with two spaces.
      const source = JSON.parse(fs.readFileSync(path.join(sourceRoot, member), 'utf8'));
      for (const field of ['private', 'scripts', 'devDependencies']) delete source[field];
      expected = Buffer.from(JSON.stringify(source, null, 2) + '\n');
    } else {
      expected = fs.readFileSync(path.join(sourceRoot, member));
    }
    if (!actual.equals(expected)) throw new Error(`app.asar content mismatch: ${member}`);
  }
  return leaves;
}

function main() {
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
    const args = [
      '.',
      'ForgeBrowserLab',
      `--platform=${plat}`,
      `--arch=${arch}`,
      `--electron-version=${electronVersion}`,
      '--out=dist',
      '--overwrite',
      `--ignore=${PACKAGE_IGNORE_SOURCE}`,
    ];
    console.log(`> ${nodeCommand} ${packagerScript} ${args.map(printableArgument).join(' ')}`);
    execFileSync(nodeCommand, [packagerScript, ...args], { cwd: ROOT, stdio: 'inherit' });
    const archivePath = path.join(ROOT, 'dist', outName,
      plat === 'darwin' ? 'ForgeBrowserLab.app/Contents/Resources/app.asar' : 'resources/app.asar');
    const members = verifyPackageArchive(archivePath);
    console.log(`Verified app.asar: ${members.length} approved runtime files`);
    console.log(`OK: dist/${outName}`);
  }
}

console.log('\nNext (optional): npm run package:portable to zip the result.');
console.log('NOTE: macOS bundles cannot be produced from Windows or Linux.');
}

if (require.main === module) main();
module.exports = { verifyPackageArchive };
