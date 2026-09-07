'use strict';

/**
 * Files that are created or mutated by ForgeOS Browser at runtime. None of
 * these may be copied into an application package from a developer checkout.
 */
const RUNTIME_ROOT_FILES = Object.freeze([
  'forge-agent-token',
  'forge-settings.json',
  'forge-history.json',
  'forge-bookmarks.json',
  'forge-allowlist.json',
  'forge-allowlist.json.presets',
  'forge-fp-level',
  'forge-session.json',
]);

const RUNTIME_DIRECTORIES = Object.freeze([
  'dist',
  'results',
  'logs',
  'downloads',
  '.git',
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const directoryPattern = RUNTIME_DIRECTORIES.map(escapeRegex).join('|');
const filePattern = RUNTIME_ROOT_FILES.map(escapeRegex).join('|');

// electron-packager evaluates this expression against paths beginning with '/'.
// Temporary/backup variants are excluded as well because atomic writes can leave
// them behind after a crash.
const PACKAGE_IGNORE_SOURCE = [
  `^/(?:${directoryPattern})(?:/|$)`,
  `^/(?:${filePattern})(?:$|[.~_-])`,
  '\\.log$',
].join('|');

const PACKAGE_IGNORE_RE = new RegExp(PACKAGE_IGNORE_SOURCE);

function normalizePackagePath(filePath) {
  return `/${String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

function isPackageExcluded(filePath) {
  return PACKAGE_IGNORE_RE.test(normalizePackagePath(filePath));
}

module.exports = {
  PACKAGE_IGNORE_SOURCE,
  RUNTIME_DIRECTORIES,
  RUNTIME_ROOT_FILES,
  isPackageExcluded,
};
