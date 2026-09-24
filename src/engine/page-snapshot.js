/*
 * page-snapshot.js — engine-side model of one observation.
 *
 * Pure Node: no Electron, no DOM. The shape here is what the Agent API returns
 * and what the loop reasons over, so it is testable without a browser.
 *
 * A snapshot is one ATOMIC read: page text plus the numbered table of elements
 * the agent may act on. The fingerprint lets the loop notice that the page
 * changed between observing and acting — a stale index must never be clicked.
 */
'use strict';

const crypto = require('crypto');
const { classifyField, queryValues, sanitizeUrl, scrubKnownValues } = require('./sensitive-fields');

const MAX_ELEMENTS = 200;
const VALID_KINDS = ['click', 'fill', 'select', 'blocked'];

/** Coerce whatever came out of the page into a trustworthy shape. */
function normalizeElement(raw, i, values = []) {
  if (!raw || typeof raw !== 'object') return null;
  const index = Number(raw.index);
  if (!Number.isFinite(index) || index <= 0) return null;
  let kind = VALID_KINDS.includes(raw.kind) ? raw.kind : 'click';
  const sensitive = !!raw.sensitive || classifyField({ type: raw.input_type || raw.type,
    autocomplete: raw.autocomplete, name: raw.field_name || raw.name,
    id: raw.id, ariaLabel: raw.label }).sensitive;
  if (sensitive && (kind === 'fill' || kind === 'select' ||
      (kind === 'click' && ['textbox', 'combobox'].includes(raw.role)))) kind = 'blocked';
  const safe = (value) => scrubKnownValues(value, values);
  return {
    index,
    role: safe(String(raw.role || 'generic')).slice(0, 40),
    kind,
    label: sensitive ? '(sensitive field)' : safe(String(raw.label || '').replace(/\s+/g, ' ').trim()).slice(0, 300) || '(unlabelled)',
    current_value: sensitive ? '' : safe(raw.current_value == null ? '' : raw.current_value).slice(0, 200),
    option_value: sensitive ? null : raw.option_value == null ? null : safe(raw.option_value).slice(0, 200),
    option_index: kind === 'select' && Number.isSafeInteger(raw.option_index) && raw.option_index >= 0
      ? raw.option_index : null,
    input_type: safe(String(raw.input_type || '')).slice(0, 40),
    sensitive,
    is_submit: !!raw.is_submit,
    is_anchor: !!raw.is_anchor,
    href: raw.href == null ? null : sanitizeUrl(safe(raw.href)).slice(0, 500),
    form_action: raw.form_action == null ? null : sanitizeUrl(safe(raw.form_action)).slice(0, 500),
    form_method: /^(get|post|dialog)$/.test(String(raw.form_method || '').toLowerCase())
      ? String(raw.form_method).toLowerCase() : null,
    _at: i,
  };
}

/**
 * @param {object} raw payload from the injected snapshot script
 * @returns {{url,title,text,elements,can_scroll_down,can_scroll_up,fingerprint,truncated}}
 */
function normalizeSnapshot(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawElements = Array.isArray(src.elements) ? src.elements : [];
  const rawBelow = Array.isArray(src.below_fold) ? src.below_fold : [];
  const knownValues = new Set(queryValues(src.url));
  for (const el of [...rawElements, ...rawBelow]) {
    if (!el || typeof el !== 'object') continue;
    for (const url of [el.href, el.form_action]) for (const value of queryValues(url, src.url)) knownValues.add(value);
    if (el.sensitive || classifyField({ type: el.input_type || el.type,
      autocomplete: el.autocomplete, name: el.field_name || el.name,
      id: el.id, ariaLabel: el.label }).sensitive) {
      for (const value of [el.current_value, el.option_value, el.label])
        if (value && String(value) !== '<REDACTED>') knownValues.add(String(value));
      for (const token of String(el.label || '').split(/\s+/)) if (token.length >= 8) knownValues.add(token);
    }
  }
  const elements = [];
  for (let i = 0; i < rawElements.length && elements.length < MAX_ELEMENTS; i += 1) {
    const el = normalizeElement(rawElements[i], i, knownValues);
    if (el) elements.push(el);
  }
  // Controls that exist out of view. They are NOT offered as action targets —
  // the action would refuse them as 'off_screen' — but the agent must know they
  // exist, or it scrolls blindly hoping to find what it cannot name.
  const below_fold = [];
  for (let i = 0; i < rawBelow.length && below_fold.length < MAX_ELEMENTS; i += 1) {
    const el = normalizeElement(rawBelow[i], i, knownValues);
    if (el) below_fold.push(el);
  }
  const snapshot = {
    url: sanitizeUrl(scrubKnownValues(src.url || '', knownValues)),
    title: scrubKnownValues(src.title || '', knownValues).slice(0, 300),
    text: scrubKnownValues(src.text || '', knownValues).slice(0, 8000),
    elements,
    scroll_y: Number.isFinite(Number(src.scroll_y)) ? Number(src.scroll_y) : 0,
    can_scroll_down: !!src.can_scroll_down,
    can_scroll_up: !!src.can_scroll_up,
    // Controls the page covers with something else. Surfaced so a caller can
    // tell "nothing to press here" from "everything here is behind an overlay".
    occluded_count: Number.isFinite(Number(src.occluded_count)) ? Number(src.occluded_count) : 0,
    below_fold,
    offscreen_count: Number.isFinite(Number(src.offscreen_count)) ? Number(src.offscreen_count) : 0,
    // The viewport the observation was judged against — [0,0] means the page
    // could not be laid out and position filtering was skipped on purpose.
    viewport: Array.isArray(src.viewport) && src.viewport.length === 2
      ? [Number(src.viewport[0]) || 0, Number(src.viewport[1]) || 0]
      : null,
    truncated: rawElements.length > elements.length,
  };
  snapshot.fingerprint = fingerprintSnapshot(snapshot);
  return snapshot;
}

/**
 * Identity of an observation. Two reads of an unchanged page produce the same
 * value; any change to the text or element table produces a different one.
 * Deliberately excludes `_at`, which is positional bookkeeping, not state.
 */
function fingerprintSnapshot(snapshot) {
  const material = {
    url: snapshot.url,
    // Scrolling IS a state change even when the text and the on-screen element
    // table are unchanged — which is exactly the case on a page whose controls
    // are all below the fold.
    scroll_y: snapshot.scroll_y,
    text: snapshot.text,
    elements: (snapshot.elements || []).map((el) => [
      el.index, el.kind, el.label, el.current_value, el.option_value, el.option_index, el.href, el.input_type, el.is_submit,
    ]),
    can_scroll_down: snapshot.can_scroll_down,
    can_scroll_up: snapshot.can_scroll_up,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

/** Elements the agent may act on with a given kind, keyed for lookup. */
function candidatesByKind(snapshot, kind) {
  const out = new Map();
  for (const el of (snapshot && snapshot.elements) || []) {
    if (el.kind === kind) out.set(kind === 'select' && Number.isSafeInteger(el.option_index)
      ? `${el.index}:${el.option_index}` : el.index, el);
  }
  return out;
}

/** Find one element by index, regardless of kind. */
function elementByIndex(snapshot, index) {
  const wanted = Number(index);
  return ((snapshot && snapshot.elements) || []).find((el) => el.index === wanted) || null;
}

/**
 * The catalogue offered to a decision-maker: one line per actionable element.
 * This is the agent's vocabulary — without it, "click that button" is unsayable.
 */
function elementCatalogue(snapshot, kind) {
  const pool = kind
    ? [...candidatesByKind(snapshot, kind).values()]
    : [...((snapshot && snapshot.elements) || []), ...((snapshot && snapshot.below_fold) || [])];
  return pool.map((el) => {
    const key = el.kind === 'select' && Number.isSafeInteger(el.option_index)
      ? `${el.index}:${el.option_index}` : el.index;
    const bits = [`[${key}]`, el.kind, `${el.role}:`, el.label];
    if (el.current_value) bits.push(`= "${el.current_value}"`);
    if (el.option_value != null) bits.push(`value="${el.option_value}"`);
    return bits.join(' ');
  });
}

/** One-line status, mirroring the done/stalled/blocked vocabulary. */
function describeSnapshot(snapshot) {
  if (!snapshot) return 'no observation';
  const counts = { click: 0, fill: 0, select: 0, blocked: 0 };
  for (const el of snapshot.elements || []) counts[el.kind] = (counts[el.kind] || 0) + 1;
  const scroll = [snapshot.can_scroll_up ? 'up' : null, snapshot.can_scroll_down ? 'down' : null].filter(Boolean);
  return `${snapshot.title || '(untitled)'} — ${counts.click} clickable, ${counts.fill} fillable, ${counts.select} selectable` +
    (scroll.length ? `, scroll ${scroll.join('/')}` : ', no scroll') +
    ` [${snapshot.fingerprint}]`;
}

module.exports = {
  normalizeSnapshot,
  fingerprintSnapshot,
  candidatesByKind,
  elementByIndex,
  elementCatalogue,
  describeSnapshot,
  MAX_ELEMENTS,
  VALID_KINDS,
};
