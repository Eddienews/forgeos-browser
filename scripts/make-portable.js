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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

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

const APP_DIR = path.join(DIST, `ForgeBrowserLab-${PLATFORM}-${ARCH}`);
const OUT_ZIP = path.join(DIST, `ForgeBrowserLab-portable-${PLATFORM}-${ARCH}.zip`);

function ensureAppPackaged() {
  let exeName;
  if (PLATFORM === 'win32') {
    exeName = 'ForgeBrowserLab.exe';
  } else if (PLATFORM === 'darwin') {
    exeName = 'ForgeBrowserLab.app/Contents/MacOS/Electron';
  } else {
    exeName = 'ForgeBrowserLab';
  }
  if (!fs.existsSync(path.join(APP_DIR, exeName))) {
    console.log('Packaged app not found; running electron-packager first...');
    execSync('npm run package', { cwd: ROOT, stdio: 'inherit' });
  }
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
- Filter lists (lists/) can be refreshed on any machine with:
    node scripts/update-lists.js   (requires Node) — or just copy lists/*.txt from another install.
- v0.4.0 — laboratory prototype. Not hardened for hostile use.
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
    execSync(`ditto -c -k --sequesterRsrc --keepParent "${APP_DIR}" "${OUT_ZIP}"`, { cwd: ROOT, stdio: 'inherit' });
  } else {
    // Linux: zip (no ditto available, no symlink issues for ELF binaries)
    execSync(`zip -r "${OUT_ZIP}" "${APP_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  }
  const mb = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`\nOK: ${OUT_ZIP} (${mb} MB)`);
}

ensureAppPackaged();
seedRuntimeDirs();
writePortableReadme();
zip();