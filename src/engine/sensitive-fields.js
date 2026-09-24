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
  /card/i,
  /cvv|cvc/,
  /(^|[^a-z])otp([^a-z]|$)/i,
  /security[-_]?code/i,
  /verification[-_ ]?code|one[-_ ]?time[-_ ]?code/i,
  /senha|cart[aã]o|c[oó]digo/i,
  /credit|debit/i,
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
 * @param {{type?: string, name?: string, id?: string, autocomplete?: string, ariaLabel?: string, label?: string, associatedLabels?: string, ariaLabelledBy?: string, metadataUncertain?: boolean}} field
 * @returns {{sensitive: boolean, kind: string|null, reason: string}}
 */
function classifyField(field) {
  const type = String(field.type || '').toLowerCase();
  const autocomplete = String(field.autocomplete || '').toLowerCase().split(/\s+/);
  const name = field.name || '';
  const id = field.id || '';
  const labels = [field.ariaLabel, field.label, field.associatedLabels, field.ariaLabelledBy].filter(Boolean).join(' ');
  const haystack = `${type} ${name} ${id} ${labels} ${field.placeholder || ''} ${field.testId || ''}`;

  if (field.metadataUncertain) return { sensitive: true, kind: 'unknown', reason: 'field metadata unavailable' };
  if (type === 'password') return { sensitive: true, kind: 'password', reason: 'type=password' };
  if (SENSITIVE_TYPES.has(type)) return { sensitive: true, kind: type, reason: `type=${type}` };
  const autocompleteHint = autocomplete.find((token) => SENSITIVE_TYPES.has(token));
  if (autocompleteHint) {
    return { sensitive: true, kind: autocompleteHint, reason: `autocomplete=${autocompleteHint}` };
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

// Serialized into both in-page readers. Treat inaccessible/malformed label
// metadata as sensitive rather than allowing an exception to skip redaction.
function domFieldInfo(el) {
  const info = { type: '', name: '', id: '', autocomplete: '', ariaLabel: '',
    ariaLabelledBy: '', associatedLabels: '', placeholder: '', testId: '' };
  try {
    const attr = (key, property = key) => {
      const value = el && typeof el.getAttribute === 'function' ? el.getAttribute(key) : null;
      return String(value || (el && el[property]) || '').trim();
    };
    info.type = attr('type') || (el.tagName === 'TEXTAREA' ? 'textarea' :
      (el.isContentEditable || el.getAttribute('contenteditable') !== null ? 'contenteditable' : 'text'));
    info.name = attr('name');
    info.id = attr('id');
    info.autocomplete = attr('autocomplete');
    info.ariaLabel = attr('aria-label');
    info.placeholder = attr('placeholder');
    info.testId = attr('data-testid');
    const ids = attr('aria-labelledby').split(/\s+/).filter(Boolean);
    info.ariaLabelledBy = ids.map((id) => {
      const target = document.getElementById(id);
      if (!target) { info.metadataUncertain = true; return ''; }
      return String(target.textContent || '');
    }).join(' ');
    if (el.labels) info.associatedLabels = Array.from(el.labels)
      .map((label) => String(label.textContent || '')).join(' ');
    const wrapping = el.closest && el.closest('label');
    if (wrapping) info.associatedLabels += ' ' + String(wrapping.textContent || '');
    if (info.id && document.querySelectorAll) {
      for (const label of document.querySelectorAll('label[for]')) {
        if (label.getAttribute('for') === info.id) info.associatedLabels += ' ' + String(label.textContent || '');
      }
    }
  } catch {
    info.metadataUncertain = true;
  }
  return info;
}

// Security inventory is independent of the actionability selector, viewport,
// and output caps. Classify every control before publishing ANY page text.
function domFieldInventory() {
  const fields = [...document.querySelectorAll('input, select, textarea'),
    ...document.querySelectorAll('[contenteditable]')];
  const entries = fields.map((el) => {
    const info = domFieldInfo(el);
    const classification = classifyField(info);
    let values = [];
    if (classification.sensitive) {
      try {
        if (info.type === 'contenteditable' || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
          // innerText may omit hidden descendants; textContent may differ from
          // the rendered/editor value. Inventory every representation first.
          values = [el.innerText, el.textContent, el.value].filter(v => v != null)
            .map(String).filter(Boolean);
          if (el.textContent == null && el.innerText == null) throw new Error('unreadable editor');
        } else values = [el.value].filter(v => v != null).map(String).filter(Boolean);
      } catch {
        // If a sensitive value cannot be read, no page copy can be proven safe.
        throw new Error('sensitive field value unavailable');
      }
    }
    return { el, info, classification, values };
  });
  return { entries, values: [...new Set(entries.flatMap(e => e.values))]
    .sort((a, b) => b.length - a.length) };
}

// These pure functions are also serialized into the injected page script.
function queryValues(url, base) {
  try { return [...new URL(String(url), base).searchParams.values()].filter(Boolean); }
  catch { return []; }
}
function sanitizeUrl(url) {
  if (url == null) return null;
  const value = String(url).replace(/([?&][^=&#?]+)=([^&#]*)/g, '$1=%3CREDACTED%3E');
  return value.replace(/#([^\s]*)$/, (_, fragment) =>
    /^[-\w]{1,80}$/.test(fragment) ? `#${fragment}` : '#%3CREDACTED%3E');
}
function scrubKnownValues(text, values) {
  let result = String(text == null ? '' : text);
  for (const value of values) {
    const token = String(value || '');
    if (!token) continue;
    // Match each character either literally or as its percent-encoded UTF-8
    // bytes. This catches fully and partially encoded URL path copies without
    // decoding or changing unrelated page text. Short values are not exempt:
    // false-positive redaction is safer than disclosing a one-character PIN.
    const pattern = [...token].map((character) => {
      const literal = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let encoded;
      try {
        const percent = encodeURIComponent(character);
        encoded = (percent === character
          ? '%' + character.charCodeAt(0).toString(16).padStart(2, '0')
          : percent).replace(/[a-f]/gi, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`);
      } catch {
        // Lone UTF-16 surrogates cannot be percent-encoded by the browser.
        // Continue scrubbing their literal form rather than aborting extraction.
        encoded = literal;
      }
      return `(?:${literal}|${encoded})`;
    }).join('');
    result = result.replace(new RegExp(pattern, 'g'), '<REDACTED>');
  }
  return result;
}
function snapshotSafetyScript() {
  return `const SENSITIVE_TYPES = new Set(${JSON.stringify([...SENSITIVE_TYPES])});
  const SENSITIVE_NAME_HINTS = [${SENSITIVE_NAME_HINTS.map(String).join(',')}];
  const classifyField = ${classifyField.toString()};
  const domFieldInfo = ${domFieldInfo.toString()};
  const domFieldInventory = ${domFieldInventory.toString()};
  const queryValues = ${queryValues.toString()};
  const sanitizeUrl = ${sanitizeUrl.toString()};
  const scrubKnownValues = ${scrubKnownValues.toString()};`;
}

const REDACTED = '<REDACTED>';

/** Redact a field value if the field is classified sensitive. */
function redactValue(field, value) {
  if (value == null) return null;
  return classifyField(field).sensitive ? REDACTED : value;
}

module.exports = { classifyField, redactValue, REDACTED, queryValues, sanitizeUrl, scrubKnownValues, snapshotSafetyScript };