/*
 * agent-view.js — Phase 10: structured, explicitly-UNTRUSTED view of page
 * content for AI agents, plus Phase 8's untrusted content boundary.
 *
 * Architecture:
 *   SYSTEM INSTRUCTIONS  ─┐
 *   USER TASK             ├─  authority (never page-derived)
 *   AGENT POLICY          ─┘
 *   ───────────────────────────── UNTRUSTED WEB CONTENT BOUNDARY
 *   PAGE CONTENT          (always `untrusted: true`, authority: none)
 *
 * Two pieces:
 *  1. IN_PAGE_SCRIPT — a self-contained IIFE injected with
 *     webContents.executeJavaScript. Collects a bounded, structured
 *     snapshot (headings / paragraphs / links / tables / buttons / inputs /
 *     forms). Sensitive input values are REDACTED in the page and never
 *     cross into the main process.
 *  2. analyzeAgentView(raw) — pure post-processing: validates URL scheme,
 *     re-checks redaction (defense in depth), runs the prompt-injection
 *     scanner, and returns the final structured view.
 *
 * The Agent View NEVER includes: cookies, localStorage, auth tokens, the
 * filesystem, environment variables, or browser state.
 */
'use strict';

const { classifyField, REDACTED, sanitizeUrl, scrubKnownValues, snapshotSafetyScript } = require('./sensitive-fields');
const { scanForPromptInjection } = require('./prompt-injection');

/* ------------------------------------------------------------------ */
/* 1. In-page extraction script                                        */
/* ------------------------------------------------------------------ */

/*
 * The page may attempt to tamper with Array.prototype etc.; this script
 * deliberately shadows common trusted helpers in its own scope.
 */
const IN_PAGE_SCRIPT = `(() => {
  const $slice = Array.prototype.slice;
  const $trim = (s) => (s == null ? '' : String(s).replace(/^\\s+|\\s+$/g, ''));
  const cap = (arr, n) => arr.slice(0, n);
  ${snapshotSafetyScript()}
  const rawAttr = (el, k) => (el && el.getAttribute ? $trim(el.getAttribute(k)) : '');
  const fieldInfo = (el) => domFieldInfo(el);
  // Discover before collecting ANY text/URL; values must not cross this boundary
  // through unrelated titles, paragraphs, link labels or URL paths.
  const inventory = domFieldInventory();
  const allFields = inventory.entries;
  const knownValues = new Set(inventory.values);
  const orderedValues = [...knownValues].sort((a, b) => b.length - a.length);
  const safe = (value) => scrubKnownValues($trim(value), orderedValues);
  const safeUrl = (value) => sanitizeUrl(safe(value));
  const $txt = (el) => safe(el && el.textContent);
  const $attr = (el, k) => safe(rawAttr(el, k));
  const $ = (sel) => cap($slice.call(document.querySelectorAll(sel)), 800);

  const headings = $('h1,h2,h3,h4,h5,h6').map((el) => ({
    level: Number(el.tagName[1]),
    text: $txt(el).slice(0, 300),
  })).filter((h) => h.text);

  const paragraphs = $('p').map((el) => $txt(el).slice(0, 2000)).filter(Boolean);

  const seenLinks = new Set();
  const links = [];
  for (const el of $('a[href]')) {
    const href = safeUrl(rawAttr(el, 'href'));
    const text = $txt(el).slice(0, 200);
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
    const key = href + '|' + text;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({ href, text });
    if (links.length >= 300) break;
  }

  const tables = [];
  for (const el of $('table')) {
    const rows = [];
    for (const tr of $slice.call(el.querySelectorAll('tr')).slice(0, 25)) {
      const cells = $slice.call(tr.querySelectorAll('th,td')).map((c) => $txt(c).slice(0, 300));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ caption: $txt(el.querySelector('caption')), rows });
    if (tables.length >= 20) break;
  }

  const buttons = [];
  for (const el of $('button, input[type=submit], input[type=button], [role=button]')) {
    const text = $txt(el) || $attr(el, 'aria-label') || $attr(el, 'value');
    if (!text) continue;
    buttons.push({
      text: String(text).slice(0, 120),
      type: (el.tagName || '').toLowerCase(),
      formAction: safeUrl(rawAttr(el, 'formaction')),
      ariaLabel: $attr(el, 'aria-label'),
    });
    if (buttons.length >= 100) break;
  }

  const inputs = [];
  for (const entry of cap(allFields, 800)) {
    const { el, info: f } = entry;
    const sensitive = entry.classification.sensitive;
    // Sensitive values NEVER leave the page.
    const value = sensitive ? '<REDACTED>' : (el.value !== undefined && el.value !== '' ? safe(String(el.value)).slice(0, 200) : '');
    inputs.push({ type: safe(f.type), name: safe(f.name), id: safe(f.id),
      autocomplete: safe(f.autocomplete), ariaLabel: safe(f.ariaLabel),
      associatedLabels: safe(f.associatedLabels), ariaLabelledBy: safe(f.ariaLabelledBy),
      metadataUncertain: !!f.metadataUncertain,
      placeholder: safe(f.placeholder), testId: safe(f.testId), sensitive, value });
    if (inputs.length >= 200) break;
  }

  const forms = [];
  for (const el of $('form')) {
    const fields = $slice.call(el.querySelectorAll('input,select,textarea,[contenteditable]')).filter((x) => x.name);
    forms.push({
      action: safeUrl(rawAttr(el, 'action')),
      method: ($attr(el, 'method') || 'get').toLowerCase(),
      fieldCount: fields.length,
      hasSensitive: fields.some((x) => classifyField(fieldInfo(x)).sensitive),
    });
    if (forms.length >= 25) break;
  }

  const metaDescription = $attr(document.querySelector('meta[name=description]'), 'content');
  const ogTitle = $attr(document.querySelector('meta[property="og:title"]'), 'content');

  return {
    url: safeUrl(window.location.href),
    title: safe(document.title || ''),
    bodyText: document.body ? safe(document.body.innerText || '').slice(0, 12000) : '',
    canonical: safeUrl(rawAttr(document.querySelector('link[rel=canonical]'), 'href')),
    metaDescription,
    ogTitle,
    headings,
    paragraphs,
    links,
    tables,
    buttons,
    inputs,
    forms,
    iframeCount: document.querySelectorAll('iframe').length,
  };
})();`;

/* ------------------------------------------------------------------ */
/* 2. Pure analyzer                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the final structured Agent View from an extraction result.
 * @param {object} raw result of IN_PAGE_SCRIPT (or test fixture snapshot)
 * @param {object} ctx
 *   - trackersBlocked: {ads, trackers, thirdParty, params} per-page counters
 *   - modeId
 * @returns {object} Phase 10 JSON
 */
function analyzeAgentView(raw, ctx = {}) {
  // main.js supplies only {url,title} when extraction fails. Without a field
  // inventory we cannot prove those raw tab strings contain no sensitive
  // value; suppress them instead of silently publishing a fallback leak.
  const hasFieldInventory = Array.isArray(raw.inputs);
  const source = hasFieldInventory ? raw : { inputs: [] };
  // The injected script already scrubs on-page duplicates. Defense in depth for
  // raw/test callers that hand the analyzer a sensitive value directly.
  const knownValues = new Set(source.inputs
    .filter((f) => f && classifyField(f).sensitive && f.value != null &&
      String(f.value).length > 0 && String(f.value) !== REDACTED)
    .map((f) => String(f.value)));
  const orderedValues = [...knownValues].sort((a, b) => b.length - a.length);
  const safe = (value) => scrubKnownValues(value, orderedValues);
  const safeUrl = (value) => sanitizeUrl(safe(value));
  const url = safeUrl(source.url || '');
  const title = safe(source.title || '');

  // Defense in depth: re-check redaction on any input that crossed over.
  const inputs = source.inputs.map((f) => {
    const cls = classifyField(f);
    const sanitized = Object.fromEntries(Object.entries(f).map(([key, value]) =>
      [key, typeof value === 'string' ? safe(value) : value]));
    if (cls.sensitive && f.value !== undefined && f.value !== null && String(f.value).length > 0) {
      return { ...sanitized, sensitive: true, value: REDACTED };
    }
    return { ...sanitized, sensitive: cls.sensitive };
  });

  const headings = (source.headings || []).map((h) => ({ level: h.level, text: safe(h.text) }));
  const paragraphs = (source.paragraphs || []).map((p) => safe(p));
  const links = (source.links || []).map((l) => ({ href: safeUrl(l.href), text: safe(l.text) }));
  const tables = (source.tables || []).map((t) => ({ caption: safe(t.caption), rows: (t.rows || []).map((r) => r.map(safe)) }));
  const buttons = (source.buttons || []).map((b) => ({ text: safe(b.text), type: safe(b.type), formAction: b.formAction ? safeUrl(b.formAction) : null }));
  const forms = (source.forms || []).map((f) => ({ action: safeUrl(f.action), method: safe(f.method), hasSensitive: !!f.hasSensitive }));

  // The scan runs over every textual channel the agent would see.
  const scan = scanForPromptInjection(
    [title, safe(source.metaDescription), safe(source.bodyText), ...paragraphs, ...headings.map((h) => h.text), ...links.map((l) => l.text + ' ' + l.href)]
      .filter(Boolean)
      .join('\n')
  );

  const trackers = ctx.trackersBlocked || { ads: 0, trackers: 0, thirdParty: 0, params: 0 };

  return {
    url, // may be '' for about:blank; agents must treat as untrusted anyway
    title,
    content: { headings, paragraphs, links, tables, buttons, inputs, forms },
    security: {
      untrusted: true,
      instruction_authority: false,
      prompt_injection_detected: scan.severity !== 'NONE',
      prompt_injection_severity: scan.severity,
      prompt_injection_findings: scan.findings.slice(0, 20),
      third_party_trackers: trackers.trackers + trackers.ads,
      mode: ctx.modeId || 'standard',
    },
    extracted_at: ctx.timestamp || null,
  };
}

/** Minimal shape used by read_page()/get_links() (Phase 25). */
function readPageView(agentView) {
  if (!agentView) return null;
  const paragraphs = (agentView.content.paragraphs || []).join('\n\n');
  const headings = (agentView.content.headings || []).map((h) => '#'.repeat(Math.min(h.level, 6)) + ' ' + h.text).join('\n');
  return { url: agentView.url, title: agentView.title, text: [headings, paragraphs].filter(Boolean).join('\n\n') };
}

module.exports = { IN_PAGE_SCRIPT, analyzeAgentView, readPageView };