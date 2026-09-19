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

const MAX_ELEMENTS = 200;
const VALID_KINDS = ['click', 'fill', 'select'];

/** Coerce whatever came out of the page into a trustworthy shape. */
function normalizeElement(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const index = Number(raw.index);
  if (!Number.isFinite(index) || index <= 0) return null;
  const kind = VALID_KINDS.includes(raw.kind) ? raw.kind : 'click';
  return {
    index,
    role: String(raw.role || 'generic').slice(0, 40),
    kind,
    label: String(raw.label || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '(unlabelled)',
    current_value: String(raw.current_value == null ? '' : raw.current_value).slice(0, 200),
    option_value: raw.option_value == null ? null : String(raw.option_value),
    href: raw.href == null ? null : String(raw.href).slice(0, 500),
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
  const elements = [];
  for (let i = 0; i < rawElements.length && elements.length < MAX_ELEMENTS; i += 1) {
    const el = normalizeElement(rawElements[i], i);
    if (el) elements.push(el);
  }
  const snapshot = {
    url: String(src.url || ''),
    title: String(src.title || '').slice(0, 300),
    text: String(src.text || '').slice(0, 8000),
    elements,
    can_scroll_down: !!src.can_scroll_down,
    can_scroll_up: !!src.can_scroll_up,
    // Controls the page covers with something else. Surfaced so a caller can
    // tell "nothing to press here" from "everything here is behind an overlay".
    occluded_count: Number.isFinite(Number(src.occluded_count)) ? Number(src.occluded_count) : 0,
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
    text: snapshot.text,
    elements: (snapshot.elements || []).map((el) => [
      el.index, el.kind, el.label, el.current_value, el.option_value, el.href,
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
    if (el.kind === kind) out.set(el.index, el);
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
  const pool = kind ? [...candidatesByKind(snapshot, kind).values()] : ((snapshot && snapshot.elements) || []);
  return pool.map((el) => {
    const bits = [`[${el.index}]`, el.kind, `${el.role}:`, el.label];
    if (el.current_value) bits.push(`= "${el.current_value}"`);
    if (el.option_value != null) bits.push(`value="${el.option_value}"`);
    return bits.join(' ');
  });
}

/** One-line status, mirroring the done/stalled/blocked vocabulary. */
function describeSnapshot(snapshot) {
  if (!snapshot) return 'no observation';
  const counts = { click: 0, fill: 0, select: 0 };
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
