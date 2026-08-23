/*
 * permissions.js — Phase 11: agent action permission gate.
 *
 * Central rule: reading can usually be automatic; acting should usually
 * require permission. Any agent-controlled action that changes external
 * state passes through this gate. Sensitive automation (passwords etc.)
 * is HUMAN_ONLY.
 *
 * Pure logic, unit-testable. The Electron layer surfaces ASK via a native
 * approval dialog; DENY and HUMAN_ONLY never reach automation.
 */
'use strict';

const VERDICTS = ['ALLOW', 'ASK', 'DENY', 'HUMAN_ONLY'];

/** Base policy table. Actions not listed default to ASK (safe default). */
const BASE_POLICY = {
  READ_PAGE: 'ALLOW',
  GET_LINKS: 'ALLOW',
  GET_AGENT_VIEW: 'ALLOW',
  OPEN_LINK: 'ALLOW',
  SEARCH_WEB: 'ALLOW',
  NAVIGATE: 'ALLOW',
  CLICK_ELEMENT: 'ASK', // dynamic: see resolveClick
  DOWNLOAD_FILE: 'ASK',
  SUBMIT_FORM: 'ASK',
  SEND_MESSAGE: 'ASK',
  POST_COMMENT: 'ASK',
  PURCHASE: 'ASK', // spec: DENY / ASK — lab default ASK with explicit note
  UPLOAD_FILE: 'ASK',
  ACCESS_LOCAL_FILE: 'ASK',
  DELETE_DATA: 'ASK',
  ENTER_PASSWORD: 'HUMAN_ONLY',
};

/** Actions that are pure reads — never ASK. */
const READ_ACTIONS = new Set(['READ_PAGE', 'GET_LINKS', 'GET_AGENT_VIEW', 'SECURITY_STATUS']);

/**
 * @param {string} action
 * @param {object} details arbitrary descriptor {url?, target?, fieldType?, ...}
 * @param {object} ctx {agentId?, pageUrl?, modeId?}
 * @returns {{verdict: string, reason: string}}
 */
function requestAction(action, details = {}, ctx = {}) {
  const a = String(action).toUpperCase().replace(/\s+/g, '_');
  const d = details || {};

  // Hard rules that ignore the table by design.
  if (a === 'ENTER_PASSWORD') {
    return { verdict: 'HUMAN_ONLY', reason: 'password entry is human-only, never automated' };
  }
  if (a === 'READ_PAGE' || a === 'GET_AGENT_VIEW' || a === 'GET_LINKS' || a === 'SECURITY_STATUS') {
    return { verdict: 'ALLOW', reason: `read-only action (${a})` };
  }

  const base = Object.prototype.hasOwnProperty.call(BASE_POLICY, a)
    ? BASE_POLICY[a]
    : 'ASK';

  // Dynamic special cases.
  if (a === 'CLICK_ELEMENT') {
    if (d.fieldSensitive) {
      return { verdict: 'HUMAN_ONLY', reason: 'click targets a sensitive field' };
    }
    const tag = String(d.tag || '').toLowerCase();
    const isSubmit = tag === 'input' && String(d.type || '') === 'submit';
    const isButton = tag === 'button';
    // Clicks that can mutate external state (submit buttons, form-associated
    // buttons) require approval; plain links are safe reads.
    if (isSubmit || (isButton && d.formAction)) {
      return { verdict: 'ASK', reason: 'click may submit a form' };
    }
    return { verdict: 'ALLOW', reason: 'click is a plain interaction / navigation' };
  }

  if (a === 'DOWNLOAD_FILE') {
    if (String(d.filename || '').match(/\.(exe|msi|bat|cmd|com|scr|ps1|vbs|jar|apk|dmg|sh|bin)$/i)) {
      return { verdict: 'ASK', reason: 'executable download requires explicit approval' };
    }
    return { verdict: 'ASK', reason: 'download requires approval' };
  }

  if (a === 'SUBMIT_FORM') {
    if (d.containsSensitiveFields) {
      return { verdict: 'HUMAN_ONLY', reason: 'form contains sensitive fields (password/card)' };
    }
    return { verdict: 'ASK', reason: 'form submission requires approval' };
  }

  if (a === 'UPLOAD_FILE') {
    return { verdict: 'ASK', reason: 'file upload requires approval' };
  }

  return { verdict: base, reason: `${a} ${base === 'ALLOW' ? 'allowed' : 'requires ' + base}` };
}

module.exports = { requestAction, BASE_POLICY, VERDICTS, READ_ACTIONS };