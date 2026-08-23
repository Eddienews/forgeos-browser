/*
 * sensitive-fields.js — Phase 12: sensitive form field classification.
 *
 * Shared by:
 *  - the agent-view extraction (values of sensitive fields are REDACTED and
 *    never exposed to the agent context),
 *  - the permission gate (automation may never silently fill these fields),
 *  - the renderer highlighter (visibility for the human user).
 *
 * Pure logic, unit-testable.
 */
'use strict';

const SENSITIVE_TYPES = new Set([
  'password', 'current-password', 'new-password', 'cc-number', 'cc-exp',
  'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-name', 'cvc', 'cvv', 'otp',
  'one-time-code', 'token', 'secret', 'private-key', 'api-key', 'pin',
]);

const SENSITIVE_NAME_HINTS = [
  /pass(word|wd|phrase)?/i,
  /pwd/i,
  /cc[-_]?(num|no|number)?/i,
  /card/,
  /cvv|cvc/,
  /(^|[^a-z])otp([^a-z]|$)/i,
  /security[-_]?code/i,
  /pin/i,
  /ssn/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /auth(orization|entication)?/i,
  /id[-_]?token/i,
  /access[-_]?key/i,
];

/**
 * @param {{type?: string, name?: string, id?: string, autocomplete?: string, ariaLabel?: string}} field
 * @returns {{sensitive: boolean, kind: string|null, reason: string}}
 */
function classifyField(field) {
  const type = (field.type || '').toLowerCase();
  const autocomplete = (field.autocomplete || '').toLowerCase();
  const name = field.name || '';
  const id = field.id || '';
  const label = field.ariaLabel || '';
  const haystack = `${type} ${name} ${id} ${label}`;

  if (type === 'password') return { sensitive: true, kind: 'password', reason: 'type=password' };
  if (SENSITIVE_TYPES.has(type)) return { sensitive: true, kind: type, reason: `type=${type}` };
  if (SENSITIVE_TYPES.has(autocomplete)) {
    return { sensitive: true, kind: autocomplete, reason: `autocomplete=${autocomplete}` };
  }
  for (const hint of SENSITIVE_NAME_HINTS) {
    // word-boundary match on name/id tokens; label matched loosely
    if (hint.test(haystack)) {
      const kind = hint.source.replace(/[^\w-]/g, '').slice(0, 16) || 'sensitive';
      return { sensitive: true, kind, reason: `name/id/label hint: ${hint.source}` };
    }
  }
  return { sensitive: false, kind: null, reason: 'not classified sensitive' };
}

const REDACTED = '<REDACTED>';

/** Redact a field value if the field is classified sensitive. */
function redactValue(field, value) {
  if (value == null) return null;
  return classifyField(field).sensitive ? REDACTED : value;
}

module.exports = { classifyField, redactValue, REDACTED };