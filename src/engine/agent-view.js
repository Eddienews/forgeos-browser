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

const { classifyField, REDACTED } = require('./sensitive-fields');
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
  const $txt = (el) => $trim(el && el.textContent);
  const $attr = (el, k) => (el && el.getAttribute ? $trim(el.getAttribute(k)) : '');
  const cap = (arr, n) => arr.slice(0, n);

  const SENSITIVE_TYPES = new Set(['password','current-password','new-password',
    'cc-number','cc-exp','cc-exp-month','cc-exp-year','cc-csc','cc-name','cvc','cvv',
    'otp','one-time-code','token','secret','private-key','api-key','pin']);
  const NAME_HINTS = [/(pass(word|wd|phrase)?|pwd)/i, /cc[-_]?(num|no|number)?/i, /card/i,
    /cvv|cvc/i, /(^|[^a-z])otp([^a-z]|$)/i, /security[-_]?code/i, /pin/i, /ssn/i,
    /secret/i, /token/i, /api[-_]?key/i, /auth(orization|entication)?/i];
  const isSensitive = (f) => {
    const type = (f.type || '').toLowerCase();
    const ac = (f.autocomplete || '').toLowerCase();
    if (type === 'password' || SENSITIVE_TYPES.has(type) || SENSITIVE_TYPES.has(ac)) return true;
    return NAME_HINTS.some((re) => re.test(type + ' ' + (f.name||'') + ' ' + (f.id||'') + ' ' + (f.ariaLabel||'')));
  };

  const $ = (sel) => cap($slice.call(document.querySelectorAll(sel)), 800);

  const headings = $('h1,h2,h3,h4,h5,h6').map((el) => ({
    level: Number(el.tagName[1]),
    text: $txt(el).slice(0, 300),
  })).filter((h) => h.text);

  const paragraphs = $('p').map((el) => $txt(el).slice(0, 2000)).filter(Boolean);

  const seenLinks = new Set();
  const links = [];
  for (const el of $('a[href]')) {
    const href = $attr(el, 'href');
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
      formAction: $attr(el, 'formaction'),
      ariaLabel: $attr(el, 'aria-label'),
    });
    if (buttons.length >= 100) break;
  }

  const inputs = [];
  for (const el of $('input, select, textarea')) {
    const f = {
      type: $attr(el, 'type') || (el.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
      name: $attr(el, 'name'),
      id: $attr(el, 'id'),
      autocomplete: $attr(el, 'autocomplete'),
      ariaLabel: $attr(el, 'aria-label'),
    };
    const sensitive = isSensitive(f);
    // Sensitive values NEVER leave the page.
    const value = sensitive ? '<REDACTED>' : (el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 200) : '');
    inputs.push({ ...f, sensitive, value });
    if (inputs.length >= 200) break;
  }

  const forms = [];
  for (const el of $('form')) {
    const fields = $slice.call(el.querySelectorAll('input,select,textarea')).filter((x) => x.name);
    forms.push({
      action: $attr(el, 'action'),
      method: ($attr(el, 'method') || 'get').toLowerCase(),
      fieldCount: fields.length,
      hasSensitive: fields.some((x) => isSensitive({
        type: $attr(x, 'type'), name: $attr(x, 'name'), id: $attr(x, 'id'),
        autocomplete: $attr(x, 'autocomplete'), ariaLabel: $attr(x, 'aria-label'),
      })),
    });
    if (forms.length >= 25) break;
  }

  const metaDescription = $attr(document.querySelector('meta[name=description]'), 'content');
  const ogTitle = $attr(document.querySelector('meta[property="og:title"]'), 'content');

  return {
    url: window.location.href,
    title: document.title || '',
    bodyText: document.body ? $trim(document.body.innerText || '').slice(0, 12000) : '',
    canonical: $attr(document.querySelector('link[rel=canonical]'), 'href') || '',
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
  const url = String((raw && raw.url) || '');
  const title = String((raw && raw.title) || '');

  // Defense in depth: re-check redaction on any input that crossed over.
  const inputs = (raw.inputs || []).map((f) => {
    const cls = classifyField(f);
    if (cls.sensitive && f.value !== undefined && f.value !== null && String(f.value).length > 0) {
      return { ...f, sensitive: true, value: REDACTED };
    }
    return { ...f, sensitive: cls.sensitive };
  });

  const headings = (raw.headings || []).map((h) => ({ level: h.level, text: h.text }));
  const paragraphs = (raw.paragraphs || []).map((p) => (typeof p === 'string' ? p : String(p)));
  const links = (raw.links || []).map((l) => ({ href: l.href, text: l.text }));
  const tables = (raw.tables || []).map((t) => ({ caption: t.caption, rows: t.rows }));
  const buttons = (raw.buttons || []).map((b) => ({ text: b.text, type: b.type, formAction: b.formAction || null }));
  const forms = (raw.forms || []).map((f) => ({ action: f.action, method: f.method, hasSensitive: !!f.hasSensitive }));

  // The scan runs over every textual channel the agent would see.
  const scan = scanForPromptInjection(
    [title, raw.metaDescription, raw.bodyText, ...paragraphs, ...headings.map((h) => h.text), ...links.map((l) => l.text + ' ' + l.href)]
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