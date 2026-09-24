'use strict';

// Explicit, reviewed runtime files tracked by the project. Never derive this
// list from a checkout directory or `git ls-files` at packaging time: newly
// added private files inside these trees must not enter a release by default.
const PACKAGE_FILES = Object.freeze([
  'LICENSE',
  'package.json',
  'assets/banner-forgeos.svg',
  'assets/forgeos-banner-2x.png',
  'assets/forgeos-banner.png',
  'assets/forgeos-screenshot-github.png',
  'lists/easylist.txt',
  'lists/easyprivacy.txt',
  'src/main.js',
  'src/page-actions.js',
  'src/page-cosmetic.js',
  'src/page-snapshot.js',
  'src/page-web-preferences.js',
  'src/preload.js',
  'src/engine/action-policy.js',
  'src/engine/agent-loop.js',
  'src/engine/agent-network-proxy.js',
  'src/engine/agent-provider.js',
  'src/engine/agent-view.js',
  'src/engine/bookmarks-history.js',
  'src/engine/cookie-policy.js',
  'src/engine/cosmetic-engine.js',
  'src/engine/credential-policy.js',
  'src/engine/download-center.js',
  'src/engine/event-log.js',
  'src/engine/filter-engine.js',
  'src/engine/fingerprint-hardening.js',
  'src/engine/fingerprint.js',
  'src/engine/network-policy.js',
  'src/engine/page-appearance.js',
  'src/engine/page-processing-policy.js',
  'src/engine/page-snapshot.js',
  'src/engine/permissions.js',
  'src/engine/privacy-modes.js',
  'src/engine/prompt-injection.js',
  'src/engine/sensitive-fields.js',
  'src/engine/session-store.js',
  'src/engine/settings.js',
  'src/engine/site-allowlist.js',
  'src/engine/snapshot-filter.js',
  'src/engine/storage-manager.js',
  'src/engine/typesafe-decider.js',
  'src/engine/url-cleaner.js',
  'src/engine/url-safety.js',
  'src/engine/view-layout.js',
  'src/ext/agent-api.js',
  'src/ext/electron-adapter.js',
  'src/ext/plugins.js',
  'src/ext/ytdlp-tools.js',
  'src/lists/ad-domains.json',
  'src/lists/analytics-domains.json',
  'src/lists/tracker-domains.json',
  'src/lists/tracking-cookies.json',
  'src/lists/tracking-params.json',
  'src/renderer/index.html',
  'src/renderer/panels.html',
  'src/renderer/panels.js',
  'src/renderer/style.css',
  'src/renderer/ui.js',
]);

// Packager checks directories before their children. Allow only ancestors of
// approved files for traversal, and only approved files as leaves. Anchoring
// at both ends also excludes backups, suffix variants, and nested additions.
const traversable = new Set(['']);
for (const file of PACKAGE_FILES) {
  const segments = file.split('/');
  for (let i = 1; i < segments.length; i++) traversable.add(segments.slice(0, i).join('/'));
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const allowedPaths = [...new Set([...PACKAGE_FILES, ...traversable])]
  .sort()
  .map(escapeRegex)
  .join('|');
const PACKAGE_IGNORE_SOURCE = `^/(?!(${allowedPaths})$)`;
const PACKAGE_IGNORE_RE = new RegExp(PACKAGE_IGNORE_SOURCE);

function isPackageExcluded(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return PACKAGE_IGNORE_RE.test(`/${normalized}`);
}

// Exact locale stems observed in both Electron 43 macOS framework bundles.
const MAC_FRAMEWORK_LOCALE_STEMS = new Set([
  'af', 'am', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el',
  'en', 'en_GB', 'es', 'es_419', 'et', 'fa', 'fi', 'fil', 'fr', 'gu', 'he',
  'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr',
  'ms', 'nb', 'nl', 'pl', 'pt_BR', 'pt_PT', 'ro', 'ru', 'sk', 'sl',
  'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'zh_CN', 'zh_TW',
]);
const MAC_FRAMEWORK_RESOURCE_PREFIX = 'ForgeBrowserLab.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/';
function isMacFrameworkLocale(name) {
  const match = /^([a-z]{2,3}(?:_(?:[A-Z]{2}|419))?)(?:_(?:FEMININE|MASCULINE|NEUTER))?\.lproj$/.exec(name);
  return !!match && MAC_FRAMEWORK_LOCALE_STEMS.has(match[1]);
}

// Mac bundle containers are traversable, but each leaf is explicitly reviewed.
function approvedMacMember(value, directory, arch) {
  const p = value.split('/');
  const resource = new Set(['app.asar', 'electron.asar', 'chrome_100_percent.pak',
    'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat', 'snapshot_blob.bin',
    'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'electron.icns']);
  const locale = name => /^[a-z]{2,3}(?:[-_][A-Za-z0-9]+)?\.lproj$/.test(name);

  // Electron Packager places its exact vendor license filenames beside .app.
  if (['LICENSE', 'LICENSES.chromium.html', 'PORTABLE.md'].includes(value)) return !directory;
  if (['logs', 'downloads', 'results'].includes(p[0])) {
    return p.length === 1 ? directory : p.length === 2 && p[1] === '.keep' && !directory;
  }
  if (p[0] !== 'ForgeBrowserLab.app') return false;
  if (p.length === 1) return directory;
  if (p[1] !== 'Contents') return false;
  if (p.length === 2) return directory;
  const t = p.slice(2);
  if (t.length === 1 && ['Info.plist', 'PkgInfo', 'CodeResources'].includes(t[0])) return !directory;
  if (t[0] === 'MacOS') return t.length === 1 ? directory :
    t.length === 2 && t[1] === 'ForgeBrowserLab' && !directory;
  if (t[0] === 'Resources') {
    if (t.length === 1) return directory;
    if (t.length === 2) return resource.has(t[1]) && !directory || locale(t[1]) && directory;
    return t.length === 3 && locale(t[1]) && t[2] === 'locale.pak' && !directory;
  }
  if (t[0] !== 'Frameworks') return false;
  if (t.length === 1) return directory;
  const helper = /^(ForgeBrowserLab Helper(?: \((?:GPU|Plugin|Renderer)\))?)\.app$/.exec(t[1]);
  if (helper) {
    if (t.length === 2) return directory;
    if (t[2] !== 'Contents') return false;
    if (t.length === 3) return directory;
    if (t.length === 4) return t[3] === 'MacOS' ? directory :
      ['Info.plist', 'PkgInfo'].includes(t[3]) && !directory;
    return t.length === 5 && t[3] === 'MacOS' && t[4] === helper[1] && !directory;
  }
  const framework = /^(Electron Framework|Mantle|ReactiveObjC|Squirrel)\.framework$/.exec(t[1]);
  if (!framework) return false;
  const name = framework[1];
  if (t.length === 2) return directory;
  const r = t.slice(2);
  if (r.length === 1) return r[0] === 'Versions' ? directory :
    [name, 'Resources', 'Libraries', 'Helpers'].includes(r[0]) && !directory;
  if (r[0] !== 'Versions') return false;
  if (r.length === 2) return r[1] === 'Current' ? !directory : r[1] === 'A' && directory;
  if (r[1] !== 'A') return false;
  const v = r.slice(2);
  if (v.length === 1) return v[0] === name ? !directory :
    ['Resources', 'Libraries', 'Helpers', '_CodeSignature'].includes(v[0]) && directory;
  if (v[0] === '_CodeSignature') return v.length === 2 && v[1] === 'CodeResources' && !directory;
  if (v[0] === 'Resources') {
    const frameworkLocale = candidate => name === 'Electron Framework' ?
      isMacFrameworkLocale(candidate) : locale(candidate);
    if (v.length === 2) return (resource.has(v[1]) || v[1] === 'Info.plist' ||
      name === 'Electron Framework' && (v[1] === 'MainMenu.nib' ||
        v[1] === `v8_context_snapshot.${arch === 'x64' ? 'x86_64' : 'arm64'}.bin`) ||
      name === 'Squirrel' && v[1] === 'ShipIt') && !directory ||
      frameworkLocale(v[1]) && directory;
    return v.length === 3 && frameworkLocale(v[1]) &&
      v[2] === 'locale.pak' && !directory;
  }
  if (v[0] === 'Libraries') return v.length === 2 && !directory &&
    (/^lib(?:EGL|GLESv2|ffmpeg|vk_swiftshader|swiftshader)\.dylib$/.test(v[1]) ||
      name === 'Electron Framework' && v[1] === 'vk_swiftshader_icd.json');
  return v[0] === 'Helpers' && v.length === 2 && v[1] === 'chrome_crashpad_handler' && !directory;
}

// Read the ZIP central directory with Node's built-ins, so the release job
// uses the same membership gate on Ubuntu as the packager uses on Windows.
// CRC verification remains the separate `unzip -t` release gate.
function verifyPortableArchive(archive, platform, arch, options = {}) {
  const fs = require('fs');
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Unsupported portable archive target');
  }
  const bytes = fs.readFileSync(archive);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i; break;
    }
  }
  if (end < 0) throw new Error('Invalid ZIP central directory');
  const count = bytes.readUInt16LE(end + 10);
  const length = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff || offset + length !== end ||
      bytes.readUInt16LE(end + 8) !== count || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) {
    throw new Error('Unsupported ZIP directory structure');
  }
  const seen = new Set();
  let hasExecutable = false;
  let hasAsar = false;
  let asarMember = null;
  const prefix = `ForgeBrowserLab-${platform}-${arch}/`;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP member');
    const flags = bytes.readUInt16LE(offset + 8);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1) throw new Error('Encrypted or truncated ZIP member');
    const raw = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const zipPath = platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
    const components = zipPath.endsWith('/') ? zipPath.slice(0, -1).split('/') : zipPath.split('/');
    if ((platform !== 'win32' && raw.includes('\\')) || zipPath.startsWith('/') ||
        components.some(segment => segment === '..' || segment === '.' || segment === '')) {
      throw new Error(`Unsafe ZIP member: ${raw}`);
    }
    if (platform === 'win32' ? zipPath.startsWith(prefix) : !zipPath.startsWith(prefix)) {
      throw new Error(`Unexpected ZIP root: ${zipPath}`);
    }
    const member = platform === 'win32' ? zipPath : zipPath.slice(prefix.length);
    if (member === '') {
      if (!zipPath.endsWith('/')) throw new Error(`Invalid ZIP root: ${zipPath}`);
      offset = next; continue;
    }
    const directory = member.endsWith('/');
    const value = directory ? member.slice(0, -1) : member;
    if (!value || seen.has(value)) throw new Error(`Duplicate ZIP member: ${raw}`);
    seen.add(value);
    const parts = value.split('/');
    let approved = false;
    if (platform === 'darwin') {
      approved = approvedMacMember(value, directory, arch);
      if (value === 'ForgeBrowserLab.app/Contents/MacOS/ForgeBrowserLab') hasExecutable = true;
      if (value === 'ForgeBrowserLab.app/Contents/Resources/app.asar') hasAsar = true;
    } else {
      const executable = platform === 'win32' ? 'ForgeBrowserLab.exe' : 'ForgeBrowserLab';
      const rootFiles = new Set([executable, 'LICENSE', 'LICENSES.chromium.html',
        'chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat', 'resources.pak',
        'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json',
        'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'libEGL.dll',
        'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll', 'chrome-sandbox',
        'libffmpeg.so', 'libGLESv2.so', 'libEGL.so', 'libvk_swiftshader.so',
        'libvulkan.so.1', 'libvulkan.so', 'chrome_crashpad_handler', 'PORTABLE.md']);
      approved = (parts.length === 1 && rootFiles.has(value)) ||
        (parts[0] === 'locales' && (parts.length === 1 && directory ||
          parts.length === 2 && /^[\w-]+\.pak$/.test(parts[1]))) ||
        (parts[0] === 'resources' && (parts.length === 1 && directory ||
          parts.length === 2 && ['app.asar', 'electron.asar'].includes(parts[1]))) ||
        (parts.length <= 2 && ['logs', 'downloads', 'results'].includes(parts[0]) &&
          (parts.length === 1 && directory || parts.length === 2 && parts[1] === '.keep'));
      if (value === executable) hasExecutable = true;
      if (value === 'resources/app.asar') hasAsar = true;
    }
    if (!approved) throw new Error(`Unapproved ZIP member: ${zipPath}`);
    if (platform === 'darwin' && (value.endsWith('/_CodeSignature') ||
      value.endsWith('/_CodeSignature/CodeResources'))) {
      const expectedType = value.endsWith('/_CodeSignature') ? 0x4000 : 0x8000;
      if ((mode & 0xf000) !== expectedType) throw new Error(`Invalid code signature ZIP mode: ${zipPath}`);
    }
    const frameworkResource = platform === 'darwin' && value.startsWith(MAC_FRAMEWORK_RESOURCE_PREFIX)
      ? value.slice(MAC_FRAMEWORK_RESOURCE_PREFIX.length) : '';
    const localePath = frameworkResource.split('/');
    if (isMacFrameworkLocale(localePath[0]) &&
        (localePath.length === 1 || localePath.length === 2 && localePath[1] === 'locale.pak')) {
      const expectedType = localePath.length === 1 ? 0x4000 : 0x8000;
      if ((mode & 0xf000) !== expectedType) throw new Error(`Invalid macOS locale ZIP mode: ${zipPath}`);
    }
    if (platform === 'darwin' && value === MAC_FRAMEWORK_RESOURCE_PREFIX + 'MainMenu.nib' &&
        (mode & 0xf000) !== 0x8000) throw new Error(`Invalid macOS menu ZIP mode: ${zipPath}`);
    if (platform === 'darwin' && frameworkResource ===
        `v8_context_snapshot.${arch === 'x64' ? 'x86_64' : 'arm64'}.bin` &&
        (mode & 0xf000) !== 0x8000) throw new Error(`Invalid macOS snapshot ZIP mode: ${zipPath}`);
    if (platform === 'darwin' && value ===
        'ForgeBrowserLab.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/vk_swiftshader_icd.json' &&
        (mode & 0xf000) !== 0x8000) throw new Error(`Invalid macOS library manifest ZIP mode: ${zipPath}`);
    if (platform === 'darwin' && value ===
        'ForgeBrowserLab.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt' &&
        (mode & 0xf000) !== 0x8000) throw new Error(`Invalid macOS ShipIt ZIP mode: ${zipPath}`);
    if (platform === 'darwin' ? value === 'ForgeBrowserLab.app/Contents/Resources/app.asar' :
      value === 'resources/app.asar') {
      if (directory || (mode & 0xf000) === 0xa000) throw new Error(`Invalid app.asar ZIP member: ${zipPath}`);
      asarMember = offset;
    }
    if ((mode & 0xf000) === 0xa000) {
      // Electron frameworks on macOS use relative version symlinks. Never
      // allow a symlink to resolve outside the bundle's Frameworks tree.
      if (platform !== 'darwin' || !value.startsWith('ForgeBrowserLab.app/Contents/Frameworks/')) {
        throw new Error(`Unapproved ZIP symlink: ${zipPath}`);
      }
      const local = bytes.readUInt32LE(offset + 42);
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) {
        throw new Error(`Invalid ZIP symlink: ${zipPath}`);
      }
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const size = bytes.readUInt32LE(offset + 20);
      const method = bytes.readUInt16LE(offset + 10);
      if (size > 4096 || start + size > bytes.length || ![0, 8].includes(method)) {
        throw new Error(`Invalid ZIP symlink: ${zipPath}`);
      }
      const content = bytes.subarray(start, start + size);
      const target = (method === 8 ? require('zlib').inflateRawSync(content) : content).toString('utf8');
      const resolved = require('path').posix.resolve('/' + value, '..', target);
      if (!target || target.startsWith('/') || !resolved.startsWith('/ForgeBrowserLab.app/Contents/Frameworks/')) {
        throw new Error(`Escaping ZIP symlink: ${zipPath}`);
      }
    }
    offset = next;
  }
  if (offset !== end || !hasExecutable || !hasAsar) throw new Error('Incomplete ZIP: executable or app.asar missing');
  if (options.sourceRoot) {
    const os = require('os');
    const path = require('path');
    const zlib = require('zlib');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-asar-'));
    try {
      const local = bytes.readUInt32LE(asarMember + 42);
      const method = bytes.readUInt16LE(asarMember + 10);
      const size = bytes.readUInt32LE(asarMember + 20);
      const expectedSize = bytes.readUInt32LE(asarMember + 24);
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50 ||
          ![0, 8].includes(method) || expectedSize > 256 * 1024 * 1024) {
        throw new Error('Invalid ZIP app.asar entry');
      }
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + size > bytes.readUInt32LE(end + 16)) throw new Error('Truncated ZIP app.asar entry');
      const compressed = bytes.subarray(start, start + size);
      const content = method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }) : compressed;
      if (content.length !== expectedSize) throw new Error('Invalid ZIP app.asar size');
      const extracted = path.join(temp, 'app.asar');
      fs.writeFileSync(extracted, content);
      require('./package').verifyPackageArchive(extracted, options.sourceRoot);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return seen.size;
}

module.exports = { PACKAGE_FILES, PACKAGE_IGNORE_SOURCE, isPackageExcluded, verifyPortableArchive };
