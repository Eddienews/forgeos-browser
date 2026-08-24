/*
 * cosmetic-engine.js — element hiding (ABP "##" rules) for ForgeOS Browser.
 *
 * Parses cosmetic rules from filter lists into two buckets:
 *   - generic:   "##.adbox"            (applies to every site)
 *   - domain-specific: "cnn.com##.banner"  (applies only on that domain)
 *
 * Matching is done in-page: this module compiles a CSS stylesheet string plus
 * a compact JSON index of domain-specific selectors; the page preload (or an
 * injected style) applies them at document_start.
 *
 * Performance notes:
 *   - Generic selectors are emitted as one big CSS blob (the browser's CSS
 *     engine matches far faster than JS could).
 *   - Domain-specific selectors live in a Map<domain, selector[]>; the page
 *     asks for its host and gets only the relevant slice.
 * Unhide rules ("#@#") remove matching earlier entries.
 */
'use strict';

/** Parse lines; returns { genericCss, byDomain: Map, stats } */
function compileCosmetic(lines) {
  const generic = [];
  const byDomain = new Map(); // domain -> Set of selectors
  let unhide = 0;

  const addDomainRule = (domains, sel) => {
    for (const d of domains) {
      if (!byDomain.has(d)) byDomain.set(d, new Set());
      byDomain.get(d).add(sel);
    }
  };

  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const hashIdx = line.indexOf('##');
    if (hashIdx === -1) continue;
    const isUnhide = line.includes('#@#');
    const body = isUnhide
      ? line.slice(line.indexOf('#@#') + 3)
      : line.slice(hashIdx + 2);
    const prefix = line.slice(0, isUnhide ? line.indexOf('#@#') : hashIdx);
    const selector = body.trim();
    if (!selector || selector.startsWith('#?#') || selector.startsWith('$#')) continue;
    // Skip procedural pseudo-classes we cannot express in plain CSS.
    if (selector.includes(':has-text') || selector.includes(':matches-')) continue;

    if (isUnhide) {
      unhide++;
      // Remove from both buckets (best-effort).
      const gi = generic.lastIndexOf(selector);
      if (gi !== -1 && !prefix) { generic.splice(gi, 1); continue; }
      if (prefix) {
        for (const d of prefix.split(',')) {
          const set = byDomain.get(d.trim().toLowerCase());
          if (set) set.delete(selector);
        }
      }
      continue;
    }

    if (!prefix) {
      generic.push(selector);
    } else {
      // "a.com,~b.com##.x" — keep positive domains only (negations ignored:
      // the generic rule rarely applies to negated hosts in practice).
      const domains = prefix.split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d && !d.startsWith('~'))
        .map((d) => d.replace(/^\*+\./, '')); // "*.example.com" → example.com
      if (domains.length) addDomainRule(domains, selector);
    }
  }

  // Build the generic CSS blob. Group identical simple class/id hides to keep
  // the sheet compact; correctness first: one rule per selector is fine.
  const genericCss = generic.length
    ? generic.map((s) => `${s}{display:none!important}`).join('\n')
    : '';

  return {
    genericCss,
    byDomain,
    stats: { generic: generic.length, domainSpecific: [...byDomain.values()].reduce((n, s) => n + s.size, 0), domains: byDomain.size, unhide },
  };
}

/** Selectors for one hostname (suffix match: news.cnn.com gets cnn.com rules). */
function selectorsForHost(compiled, hostname) {
  const out = new Set();
  const host = String(hostname || '').toLowerCase();
  if (!host) return [];
  const labels = host.split('.');
  // Walk every suffix: cnn.com and com (rare but harmless).
  for (let i = 0; i < labels.length - 0; i++) {
    const candidate = labels.slice(i).join('.');
    const set = compiled.byDomain.get(candidate);
    if (set) for (const s of set) out.add(s);
  }
  return [...out];
}

module.exports = { compileCosmetic, selectorsForHost };