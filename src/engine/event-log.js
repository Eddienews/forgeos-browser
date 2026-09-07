/*
 * event-log.js — Phase 23: local security/privacy event log.
 *
 * Local only. Never leaves the machine (No Telemetry rule, Phase 24).
 * Must never record form values, cookies, tokens, or page body text.
 *
 * Log line format follows the spec examples:
 *   [BLOCK] tracker request | host=doubleclick.net | tab=https://... | category=ADVERTISING
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const ROTATED_SUFFIX = '.1';

function truncateUtf8(value, maxBytes) {
  const encoded = Buffer.from(String(value), 'utf8');
  if (encoded.length <= maxBytes) return String(value);
  if (maxBytes <= 3) return '.'.repeat(Math.max(0, maxBytes));
  return encoded.subarray(0, maxBytes - 3).toString('utf8').replace(/\uFFFD$/u, '') + '...';
}

function escapeControls(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

class EventLog {
  /**
   * @param {string|null} filePath path to append to; null disables file writes
   * @param {number} maxMemory entries kept in the in-memory ring
   * @param {object} options bounded local-file settings
   */
  constructor(filePath = null, maxMemory = 2000, {
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    platform = process.platform,
  } = {}) {
    this.filePath = filePath;
    this.maxMemory = maxMemory;
    this.maxFileBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes >= 128
      ? maxFileBytes
      : DEFAULT_MAX_FILE_BYTES;
    this.platform = platform;
    this.entries = [];
    this.fileReady = !filePath;
    this.lastWriteOk = !filePath;
    this.lastErrorCode = null;
    this.lastErrorAt = null;
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        this._ensurePrivateRegularFile(filePath);
        this.fileReady = true;
        this.lastWriteOk = true;
      } catch (error) {
        this._recordError(error);
      }
    }
  }

  _recordError(error) {
    const candidate = error && error.code ? String(error.code) : 'write-failed';
    this.lastErrorCode = candidate.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'write-failed';
    this.lastErrorAt = new Date().toISOString();
    this.lastWriteOk = false;
  }

  _ensurePrivateRegularFile(filePath) {
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const descriptor = fs.openSync(filePath, 'wx', 0o600);
      fs.closeSync(descriptor);
      stat = fs.lstatSync(filePath);
    }
    if (!stat.isFile()) throw new Error('event log path must be a regular file');
    if (this.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    return stat;
  }

  _replacePrivateFile(filePath, contents) {
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      if (this.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, contents);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.renameSync(temporary, filePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        const existing = fs.lstatSync(filePath);
        if (!existing.isFile()) throw new Error('rotated event log path must be a regular file');
        fs.rmSync(filePath, { force: true });
        fs.renameSync(temporary, filePath);
      }
      if (this.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  _rotateIfNeeded(incomingBytes) {
    const stat = this._ensurePrivateRegularFile(this.filePath);
    if (stat.size + incomingBytes <= this.maxFileBytes) return;

    const retainedBytes = Math.min(stat.size, this.maxFileBytes);
    const retained = Buffer.alloc(retainedBytes);
    if (retainedBytes > 0) {
      const descriptor = fs.openSync(this.filePath, 'r');
      try {
        fs.readSync(descriptor, retained, 0, retainedBytes, stat.size - retainedBytes);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    this._replacePrivateFile(`${this.filePath}${ROTATED_SUFFIX}`, retained);
    fs.truncateSync(this.filePath, 0);
    if (this.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
  }

  _appendPrivate(line) {
    const boundedLine = `${truncateUtf8(line, this.maxFileBytes - 1)}\n`;
    const bytes = Buffer.from(boundedLine, 'utf8');
    this._rotateIfNeeded(bytes.length);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow,
    );
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('event log path must be a regular file');
      if (this.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, bytes);
      this.fileReady = true;
      this.lastWriteOk = true;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  _sanitize(value) {
    if (value == null) return '';
    const s = escapeControls(value);
    // Strip anything that looks like a sensitive form value or token (best-effort).
    return s.replace(/((?:password|token|secret|key|cc|cvv|cvc|otp)[=:]\s*)[^\s&;]+/gi, '$1<redacted>').slice(0, 400);
  }

  /**
   * @param {string} tag one of BLOCK, CLEAN, WARN, ASK, DENY, ALLOW, INFO, ERROR
   * @param {string} message short description
   * @param {object} fields extra key=value fields (sanitized; no bodies/values)
   */
  log(tag, message, fields = {}) {
    const ts = new Date().toISOString();
    const safeTag = this._sanitize(tag);
    const parts = [ts, `[${safeTag}]`, this._sanitize(message)];
    const sanitizedFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === '') continue;
      const safeKey = this._sanitize(k);
      const safeValue = this._sanitize(v);
      sanitizedFields[safeKey] = safeValue;
      parts.push(`${safeKey}=${safeValue}`);
    }
    const line = parts.join(' ');
    this.entries.push({ ts, tag: safeTag, message: this._sanitize(message), fields: sanitizedFields });
    if (this.entries.length > this.maxMemory) this.entries.splice(0, this.entries.length - this.maxMemory);
    if (this.filePath) {
      try {
        this._appendPrivate(line);
      } catch (error) {
        this._recordError(error);
      }
    }
    return line;
  }

  health() {
    if (!this.filePath) {
      return {
        enabled: false,
        healthy: false,
        bytes: 0,
        maxBytes: this.maxFileBytes,
        rotated: false,
        rotatedBytes: 0,
        permissions: 'disabled',
        lastErrorCode: this.lastErrorCode,
        lastErrorAt: this.lastErrorAt,
      };
    }

    let currentRegular = false;
    let currentBytes = 0;
    let permissions = this.platform === 'win32' ? 'inherited' : 'unknown';
    try {
      const current = fs.lstatSync(this.filePath);
      currentRegular = current.isFile();
      if (currentRegular) {
        currentBytes = current.size;
        if (this.platform !== 'win32') {
          permissions = (current.mode & 0o777) === 0o600 ? '0600' : 'unexpected';
        }
      }
    } catch (error) {
      if (!this.lastErrorCode) {
        const candidate = error && error.code ? String(error.code) : 'unavailable';
        permissions = 'unavailable';
        this.lastErrorCode = candidate.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unavailable';
      }
    }

    let rotated = false;
    let rotatedBytes = 0;
    try {
      const backup = fs.lstatSync(`${this.filePath}${ROTATED_SUFFIX}`);
      if (backup.isFile()) {
        rotated = true;
        rotatedBytes = backup.size;
      }
    } catch {}

    return {
      enabled: true,
      healthy: currentRegular && this.fileReady && this.lastWriteOk
        && (this.platform === 'win32' || permissions === '0600')
        && currentBytes <= this.maxFileBytes
        && (!rotated || rotatedBytes <= this.maxFileBytes),
      bytes: currentBytes,
      maxBytes: this.maxFileBytes,
      rotated,
      rotatedBytes,
      permissions,
      lastErrorCode: this.lastErrorCode,
      lastErrorAt: this.lastErrorAt,
    };
  }

  recent(n = 50) {
    return this.entries.slice(-n);
  }

  counts() {
    const out = {};
    for (const e of this.entries) out[e.tag] = (out[e.tag] || 0) + 1;
    return out;
  }

  clear() {
    this.entries = [];
  }
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES, EventLog, ROTATED_SUFFIX, escapeControls, truncateUtf8,
};
