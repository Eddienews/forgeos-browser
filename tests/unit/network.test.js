'use strict';

/* Gates B & C — Phases 2/3: request classification, policy, blocking. Test A. */
const { FilterEngine } = require('../../src/engine/filter-engine');
const { decideRequest } = require('../../src/engine/network-policy');

const engine = new FilterEngine({});

function decide(url, tabUrl, type, mode = 'standard') {
  return decideRequest({ url, tabUrl, resourceType: type, engine, modeId: mode });
}

module.exports = [
  {
    name: 'Test A — advertising request is BLOCKED',
    gate: 'C',
    fn(a) {
      const r = decide('https://ad.doubleclick.net/ad', 'https://example.com', 'image');
      a.strictEqual(r.category, 'ADVERTISING');
      a.strictEqual(r.decision, 'BLOCK');
      a.strictEqual(r.reason, 'advertising');
    },
  },
  {
    name: 'ad subdomains are blocked (suffix match)',
    gate: 'C',
    fn(a) {
      const r = decide('https://securepubads.g.doubleclick.net/gpt/pubads_impl.js', 'https://example.com', 'script');
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'googlesyndication blocked',
    gate: 'C',
    fn(a) {
      a.strictEqual(decide('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://example.com', 'script').decision, 'BLOCK');
    },
  },
  {
    name: 'analytics domain blocked by default',
    gate: 'C',
    fn(a) {
      const r = decide('https://www.google-analytics.com/ga.js', 'https://example.com', 'script');
      a.strictEqual(r.category, 'ANALYTICS');
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'hotjar / mixpanel / clarity classified ANALYTICS and blocked',
    gate: 'C',
    fn(a) {
      for (const u of [
        'https://static.hotjar.com/c/hotjar-1.js',
        'https://cdn.mxpnl.com/libs/mixpanel-2.min.js',
        'https://clarity.ms/t/1',
      ]) {
        a.strictEqual(decide(u, 'https://example.com', 'script').decision, 'BLOCK', u);
      }
    },
  },
  {
    name: 'first-party script is ALLOWED (network interception still applies)',
    gate: 'B',
    fn(a) {
      const r = decide('https://example.com/app.js', 'https://example.com', 'script');
      a.strictEqual(r.category, 'FIRST_PARTY');
      a.strictEqual(r.decision, 'ALLOW');
    },
  },
  {
    name: 'first-party subdomain treated as first-party',
    gate: 'B',
    fn(a) {
      a.strictEqual(decide('https://cdn.example.com/lib.js', 'https://example.com', 'script').category, 'FIRST_PARTY');
    },
  },
  {
    name: 'third-party with no filter match: allowed in standard, blocked in strict (script)',
    gate: 'B',
    fn(a) {
      const url = 'https://cdn.other-domain.com/lib.js';
      a.strictEqual(decide(url, 'https://example.com', 'script', 'standard').decision, 'ALLOW');
      a.strictEqual(decide(url, 'https://example.com', 'script', 'strict').decision, 'BLOCK');
      // Documents (frames) still allowed in strict — navigation must not break.
      a.strictEqual(decide(url, 'https://example.com', 'subFrame', 'strict').decision, 'ALLOW');
    },
  },
  {
    name: 'unknown scheme is UNKNOWN and allowed',
    gate: 'B',
    fn(a) {
      const r = decide('data:text/html,hi', 'https://example.com', 'other');
      a.strictEqual(r.category, 'UNKNOWN');
      a.strictEqual(r.decision, 'ALLOW');
    },
  },
  {
    name: 'tracker heuristic (scorecardresearch keyword) without list match',
    gate: 'C',
    fn(a) {
      const r = decide('https://zero.subdomain.scorecardresearch.com/beacon.js', 'https://example.com', 'script');
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'ABP rule: ||domain^ hostname rule (hard block via filterDecision)',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      e.loadAbpLines(['||adserver.example^'], { source: 'unit' });
      const r = e.classifyRequest({ url: 'https://x.adserver.example/pix.gif', tabUrl: 'https://example.com', resourceType: 'image' });
      a.strictEqual(r.filterDecision, 'block');
      a.strictEqual(decideRequest({ url: 'https://x.adserver.example/pix.gif', tabUrl: 'https://example.com', resourceType: 'image', engine: e, modeId: 'standard' }).decision, 'BLOCK');
      // Same-host resource untouched by the rule, first-party allowed.
      a.strictEqual(e.classifyRequest({ url: 'https://www.example.com/lib.js', tabUrl: 'https://example.com', resourceType: 'script' }).category, 'FIRST_PARTY');
    },
  },
  {
    name: 'ABP rule: ||domain/path^ path prefix',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      e.loadAbpLines(['||cdn.example/ads^'], { source: 'unit' });
      const hit = e.classifyRequest({ url: 'https://cdn.example/ads/banner.js', tabUrl: 'https://example.com', resourceType: 'script' });
      a.strictEqual(hit.filterDecision, 'block');
      a.strictEqual(decideRequest({ url: 'https://cdn.example/ads/banner.js', tabUrl: 'https://example.com', resourceType: 'script', engine: e, modeId: 'standard' }).decision, 'BLOCK');
      const miss = e.classifyRequest({ url: 'https://cdn.example/lib.js', tabUrl: 'https://example.com', resourceType: 'script' });
      a.strictEqual(miss.filterDecision, null);
    },
  },
  {
    name: 'ABP rule: @@ exception wins over block AND over heuristic (ABP semantics)',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      e.loadAbpLines(['||doubleclick.example^', '@@||allowed.doubleclick.example^'], { source: 'unit' });
      const blocked = e.classifyRequest({ url: 'https://doubleclick.example/a.gif', tabUrl: 'https://example.com', resourceType: 'image' });
      a.strictEqual(blocked.filterDecision, 'block');
      const allowed = e.classifyRequest({ url: 'https://allowed.doubleclick.example/a.gif', tabUrl: 'https://example.com', resourceType: 'image' });
      a.strictEqual(allowed.filterDecision, 'exception');
      // Even though the hostname heuristic says ADVERTISING, the exception wins:
      a.strictEqual(decideRequest({ url: 'https://allowed.doubleclick.example/a.gif', tabUrl: 'https://example.com', resourceType: 'image', engine: e, modeId: 'standard' }).decision, 'ALLOW');
    },
  },
  {
    name: 'ABP rule: /regex/ rule',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      e.loadAbpLines(['/ads\\?id=[0-9]+/'], { source: 'unit' });
      const r = e.classifyRequest({ url: 'https://example.com/ads?id=123', tabUrl: 'https://example.com', resourceType: 'other' });
      a.strictEqual(r.filterDecision, 'block');
    },
  },
  {
    name: 'ABP rule: $third-party option respected',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      e.loadAbpLines(['||assets.marketing.example^$third-party'], { source: 'unit' });
      // Third-party context → blocked
      const tp = e.classifyRequest({ url: 'https://assets.marketing.example/p.js', tabUrl: 'https://news.example', resourceType: 'script' });
      a.strictEqual(tp.filterDecision, 'block');
      // First-party context (same host) → rule does not apply
      const fp = e.classifyRequest({ url: 'https://assets.marketing.example/p.js', tabUrl: 'https://marketing.example', resourceType: 'script' });
      a.strictEqual(fp.filterDecision, null);
      a.strictEqual(fp.category, 'FIRST_PARTY');
    },
  },
  {
    name: 'unknown third-party request blocked in strict mode',
    gate: 'B',
    fn(a) {
      const r = decide('https://mystery.example/beacon', 'https://example.com', 'ping', 'strict');
      a.strictEqual(r.category, 'THIRD_PARTY');
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'EasyList-format cosmetic/comment lines are skipped without breaking the engine',
    gate: 'C',
    fn(a) {
      const e = new FilterEngine({ adDomains: [], trackerDomains: [], analyticsDomains: [] });
      const c = e.loadAbpLines(['! comment', 'example.com##.ad-banner', '||blocked.example^', '#footer {display:none}'], { source: 'unit' });
      a.strictEqual(c.cosmeticSkipped, 1); // ##.ad-banner
      a.strictEqual(c.commentSkipped, 2);  // '! comment' and '#footer...'
      const r = e.classifyRequest({ url: 'https://blocked.example/x', tabUrl: 'https://example.com', resourceType: 'other' });
      a.strictEqual(r.filterDecision, 'block');
      a.strictEqual(decideRequest({ url: 'https://blocked.example/x', tabUrl: 'https://example.com', resourceType: 'other', engine: e, modeId: 'standard' }).decision, 'BLOCK');
    },
  },
];