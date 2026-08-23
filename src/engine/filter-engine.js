/*
 * filter-engine.js — Phase 3: ad/tracker blocking engine.
 *
 * Two layers:
 *  1. Domain sets (src/lists/*-domains.json): fast, curated, separately
 *     maintainable. Match is full-host or suffix (subdomains).
 *  2. Adblock Plus-format rules (lists/*.txt): parser supporting the common
 *     subset needed for real EasyList/EasyPrivacy lines:
 *       ||host^               hostname rule (block host and subdomains)
 *       ||host/path           hostname + path prefix
 *       |http://host/path     exact URL prefix
 *       host/path             plain substring
 *       /regex/               regular expression rule
 *       @@ exceptions (win over blocks, ABP semantics)
 *       $third-party,$domain=...,~domain=...,$image/script/xhr/... options
 *     Cosmetic rules (#$# etc.) are parsed and ignored (not needed for a
 *     network-level lab prototype); they are counted for transparency.
 *
 * Pure logic, no Electron. Fully unit-testable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIST_DIR = path.join(__dirname, '..', 'lists');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(LIST_DIR, name), 'utf8'));
}

/* ------------------------------------------------------------------ */
/* Layer 1: domain sets                                                */
/* ------------------------------------------------------------------ */

class DomainSetMatcher {
  constructor(domains, kind) {
    this.kind = kind;
    // Store by reversed label chain for suffix matching.
    this.trie = { children: {}, terminal: false };
    for (const d of domains) this.#insert(d.trim().toLowerCase());
  }

  #insert(domain) {
    if (!domain) return;
    const labels = domain.split('.').reverse();
    let node = this.trie;
    for (const lab of labels) {
      if (!node.children[lab]) node.children[lab] = { children: {}, terminal: false };
      node = node.children[lab];
    }
    node.terminal = true;
  }

  /** true when host === domain or host ends with '.' + domain */
  matches(host) {
    if (!host) return false;
    const labels = host.toLowerCase().split('.').reverse();
    let node = this.trie;
    for (const lab of labels) {
      node = node.children[lab];
      if (!node) return false;
      if (node.terminal) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Layer 2: Adblock Plus-format rules                                  */
/* ------------------------------------------------------------------ */

class ABPRule {
  /**
   * @param {string} body rule body (after @@/|anchors stripped)
   * @param {object} opts parsed options
   * @param {'hostname'|'prefix-url'|'substring'|'regexp'} kind
   * @param {string} raw original line
   */
  constructor(kind, body, opts, raw) {
    this.kind = kind;
    this.body = body;
    this.opts = opts;
    this.raw = raw;
    this.regex = null;
    if (kind === 'hostname' || kind === 'prefix-url') {
      const host = body.split('/')[0];
      this.host = host;
      this.path = body.includes('/') ? body.slice(host.length + 1) : '';
    } else if (kind === 'regexp') {
      this.regex = new RegExp(body, 'i');
    }
  }

  matchesUrl(url, hostname, resourceType) {
    switch (this.kind) {
      case 'hostname':
        return hostMatches(hostname, this.host) &&
          (this.path === '' || url.includes(this.host + '/' + this.path));
      case 'prefix-url':
        return url.toLowerCase().startsWith(this.body.toLowerCase());
      case 'substring':
        return url.toLowerCase().includes(this.body.toLowerCase());
      case 'regexp':
        return this.regex.test(url);
      default:
        return false;
    }
  }
}

function hostMatches(hostname, ruleHost) {
  hostname = hostname.toLowerCase();
  ruleHost = ruleHost.toLowerCase();
  return hostname === ruleHost || hostname.endsWith('.' + ruleHost);
}

/** Parse '$' options: third-party, first-party, domain=a.com|b.com, ~c.com, image, script ... */
function parseOptions(str) {
  const opts = { thirdParty: false, firstParty: false, domains: null, notDomains: [], type: null };
  for (const part of str.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p === 'third-party') opts.thirdParty = true;
    else if (p === 'first-party') opts.firstParty = true;
    else if (p.startsWith('domain=')) {
      const list = p.slice(7).split('|').filter(Boolean);
      opts.domains = opts.domains ? opts.domains.concat(list) : list;
    } else if (p.startsWith('~')) opts.notDomains.push(p.slice(1));
    else if (/^(image|script|stylesheet|xhr|font|media|websocket|object|subdocument|document|ping|other)$/.test(p)) {
      opts.type = p;
    }
    // unknown/unsupported options are ignored (best-effort parser)
  }
  return opts;
}

/**
 * Compile a list of filter-list lines (array of strings) into an engine.
 * Cosmetic/comment lines are counted and skipped.
 */
function compileFilterList(lines, { source = 'inline' } = {}) {
  const blocks = [];
  const exceptions = [];
  let cosmeticSkipped = 0;
  let commentSkipped = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (!line) continue;
    if (line.startsWith('!') || line.startsWith('#')) { commentSkipped++; continue; }
    // Cosmetic rules (##, #?#, #@#, $#) — not needed at network layer.
    if (line.includes('##') || line.includes('#@#') || line.includes('#?#') ||
        line.includes('$#') || line.endsWith('#$#')) { cosmeticSkipped++; continue; }
    if (line.startsWith('@@')) {
      exceptions.push(parseRule(line.slice(2), true));
    } else {
      blocks.push(parseRule(line, false));
    }
  }
  return {
    source,
    blocks,
    exceptions,
    cosmeticSkipped,
    commentSkipped,
    matches(url, hostname, resourceType, tabHost) {
      // ABP semantics: exceptions are evaluated before blocks and win.
      for (const e of exceptions) {
        if (e.matchesUrl(url, hostname, resourceType) && domainChecks(e, tabHost)) {
          return { matched: true, kind: 'exception', rule: e.raw };
        }
      }
      for (const b of blocks) {
        if (!b.matchesUrl(url, hostname, resourceType)) continue;
        if (!domainChecks(b, tabHost)) continue;
        if (b.opts.thirdParty && tabHost && isSameHost(hostname, tabHost)) continue; // $third-party: same origin exempt
        if (b.opts.firstParty && (!tabHost || !isSameHost(hostname, tabHost))) continue; // $first-party: cross-origin exempt
        return { matched: true, kind: 'block', rule: b.raw };
      }
      return { matched: false, kind: null, rule: null };
    },
  };
}

function parseRule(rest, isException) {
  rest = rest.trim();
  let opts = { thirdParty: false, firstParty: false, domains: null, notDomains: [], type: null };
  const dollar = rest.lastIndexOf('$');
  if (dollar !== -1) {
    opts = parseOptions(rest.slice(dollar + 1));
    rest = rest.slice(0, dollar);
  }
  if (rest.startsWith('||')) {
    const body = rest.slice(2).replace(/\^/g, '');
    return new ABPRule('hostname', body, opts, (isException ? '@@' : '') + rest);
  }
  if (rest.startsWith('|')) {
    return new ABPRule('prefix-url', rest.slice(1).replace(/\^/g, '').toLowerCase(), opts, (isException ? '@@' : '') + rest);
  }
  if (rest.startsWith('/') && rest.lastIndexOf('/') > 0) {
    const body = rest.slice(1, rest.lastIndexOf('/'));
    return new ABPRule('regexp', body, opts, (isException ? '@@' : '') + rest);
  }
  return new ABPRule('substring', rest.replace(/\^/g, '').toLowerCase(), opts, (isException ? '@@' : '') + rest);
}

function isSameHost(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function domainChecks(rule, tabHost) {
  if (!tabHost) return rule.opts.domains ? false : true;
  if (rule.opts.domains && !rule.opts.domains.some((d) => hostMatches(tabHost, d))) return false;
  if (rule.opts.notDomains.some((d) => hostMatches(tabHost, d))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Combined engine                                                     */
/* ------------------------------------------------------------------ */

class FilterEngine {
  constructor({ adDomains, trackerDomains, analyticsDomains } = {}) {
    this.ad = new DomainSetMatcher(adDomains || loadJson('ad-domains.json').domains, 'ad');
    this.tracker = new DomainSetMatcher(trackerDomains || loadJson('tracker-domains.json').domains, 'tracker');
    this.analytics = new DomainSetMatcher(analyticsDomains || loadJson('analytics-domains.json').domains, 'analytics');
    this.abp = null;
  }

  /** Optionally merge an Adblock-format list (EasyList/EasyPrivacy lines). */
  loadAbpLines(lines, { source } = {}) {
    const compiled = compileFilterList(lines, { source });
    if (!this.abp) this.abp = compiled;
    else {
      this.abp.blocks.push(...compiled.blocks);
      this.abp.exceptions.push(...compiled.exceptions);
      this.abp.cosmeticSkipped += compiled.cosmeticSkipped;
      this.abp.commentSkipped += compiled.commentSkipped;
    }
    return compiled; // caller can inspect counts
  }

  /**
   * Classify an outgoing request (Phase 2 categories).
   * @returns {object} { category, firstParty, reason, matchedRule }
   */
  classifyRequest({ url, tabUrl, resourceType = 'other' }) {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { return { category: 'UNKNOWN', firstParty: null, reason: 'unparsable url' }; }
    const scheme = (url.split(':')[0] || '').toLowerCase();
    if (!['http', 'https'].includes(scheme)) {
      return { category: 'UNKNOWN', firstParty: false, reason: `scheme ${scheme}` };
    }
    let tabHost = '';
    try { tabHost = new URL(tabUrl).hostname.toLowerCase(); } catch {}
    const firstParty = tabHost ? isSameHost(hostname, tabHost) : resourceType === 'mainFrame';

    let category = null;
    let reason = null;
    let matchedRule = null;
    let filterDecision = null; // 'block' | 'exception' | null (ABP list verdict)

    // Filter lists are evaluated FIRST: an explicit @@ exception overrides
    // every heuristic/domain-list hit below (ABP semantics), and an explicit
    // block is a hard block regardless of the category heuristic.
    if (this.abp) {
      const m = this.abp.matches(url, hostname, resourceType, tabHost);
      if (m.matched) {
        matchedRule = m.rule;
        filterDecision = m.kind;
        reason = `filter list rule: ${m.rule}`;
      }
    }

    if (this.analytics.matches(hostname)) { category = 'ANALYTICS'; reason = reason || 'analytics domain list'; }
    else if (this.ad.matches(hostname)) { category = 'ADVERTISING'; reason = reason || 'ad domain list'; }
    else if (this.tracker.matches(hostname)) { category = 'TRACKING'; reason = reason || 'tracker domain list'; }

    if (!category) {
      // Heuristics on hostname keywords (second line of defence).
      const labels = hostname.split('.');
      const kw = /(^|[-.])?(adserver|ads?\.|advertising|tracker|tracking|analytics|metrics|pixel|beacon|telemetry|doubleclick|googlead|googlesyndication|scorecard)([-.]|$)/;
      if (labels.some((l) => kw.test(l))) {
        const anal = /(analytics|metrics|telemetry|scorecard|mixpanel|hotjar)/i.test(hostname);
        category = anal ? 'ANALYTICS' : 'ADVERTISING';
        reason = reason || 'hostname heuristic';
      }
    }

    if (!category) {
      category = firstParty ? 'FIRST_PARTY' : 'THIRD_PARTY';
      reason = reason || (firstParty ? 'first-party resource' : 'third-party, no filter match');
    }
    return { category, firstParty, reason, matchedRule, filterDecision };
  }
}

module.exports = { FilterEngine, DomainSetMatcher, compileFilterList, hostMatches };