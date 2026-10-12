/*
 * download-center.js — pure helpers for the in-session download registry.
 */
'use strict';

const path = require('path');
const fs = require('fs');

function upsertDownload(list, patch, limit = 50) {
  if (!Array.isArray(list) || !patch || !patch.id) return null;
  const index = list.findIndex((item) => item.id === patch.id);
  const previous = index >= 0 ? list[index] : {};
  const record = {
    ...previous,
    ...patch,
    time: patch.time || previous.time || new Date().toISOString(),
  };
  if (index >= 0) list.splice(index, 1);
  list.unshift(record);
  if (list.length > Math.max(1, limit)) list.length = Math.max(1, limit);
  return record;
}

function progressPercent(received, total) {
  const done = Number(received);
  const size = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(size) || size <= 0) return null;
  return Math.max(0, Math.min(100, (done / size) * 100));
}

function isPathInside(baseDir, candidate) {
  if (!baseDir || !candidate) return false;
  const base = path.resolve(baseDir);
  const file = path.resolve(candidate);
  return file !== base && file.startsWith(base + path.sep);
}

function isExistingPathInside(baseDir, candidate, fsImpl = fs) {
  if (!isPathInside(baseDir, candidate)) return false;
  try {
    const base = fsImpl.realpathSync(baseDir);
    const file = fsImpl.realpathSync(candidate);
    return isPathInside(base, file);
  } catch {
    return false;
  }
}

// "Open" hands a file to the operating system's default handler. A list of
// dangerous extensions can never be complete across three platforms, so only
// inert document and media types may be opened; everything else is reveal-only.
const OPENABLE_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'log', 'vtt', 'srt', 'pdf', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'mp4', 'm4v', 'mkv', 'webm', 'mov',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac',
]);

function isSafeToOpen(filePath) {
  const name = path.basename(String(filePath || ''));
  // Windows ignores trailing dots and spaces when choosing a handler.
  if (!name || /[. ]$/.test(name)) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return OPENABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

module.exports = { isExistingPathInside, isPathInside, isSafeToOpen, progressPercent, upsertDownload };
