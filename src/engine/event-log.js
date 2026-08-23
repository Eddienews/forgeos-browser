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

class EventLog {
  /**
   * @param {string|null} filePath path to append to; null disables file writes
   * @param {number} maxMemory entries kept in the in-memory ring
   */
  constructor(filePath = null, maxMemory = 2000) {
    this.filePath = filePath;
    this.maxMemory = maxMemory;
    this.entries = [];
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {}
    }
  }

  _sanitize(value) {
    if (value == null) return '';
    const s = String(value);
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
    const parts = [ts, `[${tag}]`, this._sanitize(message)];
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === '') continue;
      parts.push(`${this._sanitize(k)}=${this._sanitize(v)}`);
    }
    const line = parts.join(' ');
    this.entries.push({ ts, tag, message: this._sanitize(message), fields });
    if (this.entries.length > this.maxMemory) this.entries.splice(0, this.entries.length - this.maxMemory);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, line + '\n', 'utf8');
      } catch {}
    }
    return line;
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

module.exports = { EventLog };