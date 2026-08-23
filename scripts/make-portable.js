/*
 * scripts/make-portable.js — build a portable ZIP of Forge Browser Lab.
 *
 * Produces: dist/ForgeBrowserLab-portable-win32-x64.zip
 * Contains the packaged app (from `npm run package`) plus a README with
 * run instructions. The target machine needs NOTHING installed — the
 * Electron runtime is bundled.
 *
 * Usage: npm run package && npm run package:portable
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const APP_DIR = path.join(DIST, `ForgeBrowserLab-${PLATFORM}-${ARCH}`);
const OUT_ZIP = path.join(DIST, `ForgeBrowserLab-portable-${PLATFORM}-${ARCH}.zip`);

function ensureAppPackaged() {
  const exeName = PLATFORM === 'win32' ? 'ForgeBrowserLab.exe'
    : PLATFORM === 'darwin' ? 'ForgeBrowserLab.app/Contents/MacOS/Electron'
    : 'ForgeBrowserLab';
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

Run: double-click **ForgeBrowserLab.exe**

- No installation needed. The Electron runtime is bundled.
- Keep this folder writable: logs/, downloads/ and results/ live next to the exe.
- Filter lists (lists/) can be refreshed on any machine with:
    node scripts/update-lists.js   (requires Node) — or just copy lists/*.txt from another install.
- v0.1.0 — laboratory prototype. Not hardened for hostile use.
`;
  fs.writeFileSync(path.join(APP_DIR, 'PORTABLE.md'), md);
}

function zip() {
  if (PLATFORM === 'win32') {
    if (fs.existsSync(OUT_ZIP)) fs.unlinkSync(OUT_ZIP);
    const ps = `Compress-Archive -Path '${APP_DIR}\\*' -DestinationPath '${OUT_ZIP}' -Force`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { cwd: ROOT, stdio: 'inherit' });
  } else {
    // macOS / Linux: ditto preserves symlinks and metadata for .app bundles.
    execSync(`ditto -c -k --sequesterRsrc --keepParent "${APP_DIR}" "${OUT_ZIP}"`, { cwd: ROOT, stdio: 'inherit' });
  }
  const mb = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`\nOK: ${OUT_ZIP} (${mb} MB)`);
}

ensureAppPackaged();
seedRuntimeDirs();
writePortableReadme();
zip();