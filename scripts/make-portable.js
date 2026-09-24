/*
 * scripts/make-portable.js — build a portable ZIP of Forge Browser Lab.
 *
 * Accepts --platform and --arch to select the target build:
 *   node scripts/make-portable.js                            host platform + host arch
 *   node scripts/make-portable.js --platform=linux --arch=arm64
 *
 * Zip tool: ditto on macOS, zip on Linux, PowerShell Compress-Archive on Windows.
 * The target machine needs NOTHING installed — the Electron runtime is bundled.
 *
 * Usage: npm run package && npm run package:portable
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyPortableArchive } = require('./package-policy');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = require(path.join(ROOT, 'package.json'));

// Parse --platform=... and --arch=...
const platArg = process.argv.find(a => a.startsWith('--platform='));
const archArg = process.argv.find(a => a.startsWith('--arch='));

const hostPlatform = process.platform;
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';

const PLATFORM = platArg
  ? platArg.split('=')[1].trim()
  : hostPlatform;
const ARCH = archArg
  ? archArg.split('=')[1].trim()
  : hostArch;
if (!['win32', 'darwin', 'linux'].includes(PLATFORM) || !['x64', 'arm64'].includes(ARCH) ||
    PLATFORM === 'win32' && ARCH === 'arm64') {
  throw new Error('Unsupported portable archive target');
}

const APP_DIR = path.join(DIST, `ForgeBrowserLab-${PLATFORM}-${ARCH}`);
const OUT_ZIP = path.join(DIST, `ForgeBrowserLab-portable-${PLATFORM}-${ARCH}.zip`);

function ensureAppPackaged() {
  // Never zip an output directory left by a previous build or an app run.
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/package.js'),
    `--platform=${PLATFORM}`, `--arch=${ARCH}`], { cwd: ROOT, stdio: 'inherit' });
}

/** Copy runtime-writable dirs so first launch works out of the box. */
function seedRuntimeDirs() {
  for (const dir of ['logs', 'downloads', 'results']) {
    fs.mkdirSync(path.join(APP_DIR, dir), { recursive: true });
    // .gitkeep-style placeholder so the folder survives zipping
    const keep = path.join(APP_DIR, dir, '.keep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
}

function writePortableReadme() {
  const md = `# Forge Browser Lab (portable)

Run:
${PLATFORM === 'win32' ? '- Double-click **ForgeBrowserLab.exe**' : PLATFORM === 'darwin' ? '- Open **ForgeBrowserLab.app**' : '- Run **./ForgeBrowserLab** from the terminal'}

- No installation needed. The Electron runtime is bundled.
- Keep this folder writable: logs/, downloads/ and results/ live next to the executable.
- Filter lists are bundled inside the app archive. To update them, build a new package from a trusted source checkout.

- v${manifest.version} — laboratory prototype. Not hardened for hostile use.
`;
  fs.writeFileSync(path.join(APP_DIR, 'PORTABLE.md'), md);
}

function zip() {
  if (fs.existsSync(OUT_ZIP)) fs.unlinkSync(OUT_ZIP);

  if (PLATFORM === 'win32') {
    const ps = `Compress-Archive -Path '${APP_DIR}\\*' -DestinationPath '${OUT_ZIP}' -Force`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { cwd: ROOT, stdio: 'inherit' });
  } else if (PLATFORM === 'darwin') {
    // ditto preserves symlinks and metadata for .app bundles.
    execSync(`ditto -c -k --keepParent "${APP_DIR}" "${OUT_ZIP}"`, { cwd: ROOT, stdio: 'inherit' });
  } else {
    // Archive relative to dist so extracted members never encode a checkout path.
    execSync(`zip -r "${OUT_ZIP}" "${path.basename(APP_DIR)}"`, { cwd: DIST, stdio: 'inherit' });
  }
  const mb = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`\nOK: ${OUT_ZIP} (${mb} MB)`);
  verifyPortableArchive(OUT_ZIP, PLATFORM, ARCH);
}

const verification = process.argv.find(arg => arg.startsWith('--verify-archive='));
if (verification) {
  const sourceRoot = process.argv.includes('--verify-source') ? ROOT : undefined;
  console.log(`Verified ${verifyPortableArchive(verification.slice('--verify-archive='.length), PLATFORM, ARCH,
    { sourceRoot })} ZIP members${sourceRoot ? ' and app.asar source bytes' : ''}`);
} else {
ensureAppPackaged();
seedRuntimeDirs();
writePortableReadme();
zip();
}
