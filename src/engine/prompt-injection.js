/*
 * prompt-injection.js — Phase 9: experimental prompt-injection scanner.
 *
 * ADVISORY ONLY. This scanner is NOT perfect security; it is a heuristic
 * triage aid. Findings never delete or alter page content; suspicious text
 * is QUARANTINED in the report — i.e. surfaced to the human and flagged as
 * untrusted — and always remains visible as content (see THREAT_MODEL.md).
 *
 * Anything below the untrusted boundary has instruction authority NONE,
 * regardless of what the scanner says.
 *
 * Severity scale: LOW < MEDIUM < HIGH < CRITICAL.
 *
 * Pure logic, unit-testable.
 */
'use strict';

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

// Rules: [regex, severity, label]
const RULES = [
  // ---- CRITICAL: instruction override + disclosure/exfiltration ----
  [/(ignore|disregard|forget|skip|override)\s+(the\s+user'?s\s+)?((all|any|above|previous|prior|earlier)\s+)?(instructions?|directives?|prompts?|rules?)/i, 'CRITICAL', 'attempt to override instructions'],
  [/override\s+(your\s+)?(previous|prior|system|developer)\s+(instructions?|prompt|directives?)/i, 'CRITICAL', 'attempt to override system instructions'],
  [/(reveal|disclose|print|show|share|leak|output|display|repeat|copy)\s+(your|the|their|its|all)\s+(system\s*prompt|system\s*instructions|initial\s*prompt|first\s*message|developer\s*(message|prompt|instructions)|hidden\s*instructions?|underlying\s*prompt)/i, 'CRITICAL', 'request to disclose system prompt'],
  [/(reveal|disclose|print|show|share|leak|output|give|send|hand\s*over)\s*.{0,60}\b(credentials|passwords?|secrets?|api[-\s]?keys?|access\s*tokens?|auth(entication|orization)?\s*tokens?|private\s*keys?|session\s*(tokens?|ids?|cookies?))\b/i, 'CRITICAL', 'request for secrets or authentication material'],
  [/(upload|send|exfiltrate|transfer|steal|copy)\s*.{0,60}\b(local\s*(files?|configuration)|configuration\s*file|config(\.|_)?(json|yaml|yml|toml|env)|\.env|\/etc\/passwd|\/etc\/shadow|c:\\[a-z]|%userprofile%|~\/\w+)\b/i, 'CRITICAL', 'request to exfiltrate local files'],
  [/(access|read|open)\s*(and\s*(read|open|exfiltrate))?\s*.{0,50}\b(local\s*(files?|file\s*system)|file\s*system|\/etc\/|c:\\)\b/i, 'CRITICAL', 'request to access local filesystem'],
  [/(send|transmit|upload|exfiltrate)\s+(them\s|your\s|their\s|the\s+user'?s\s)?(files?|documents?|data|personal\s+information|messages?)/i, 'HIGH', 'request to transmit user data off-machine'],

  // ---- HIGH: role/behavior takeover, hidden behavior ----
  [/(from\s+now\s*on|starting\s+now)\s*,\s*(ignore|forget|disregard|do\s*not\s*(follow|obey))/i, 'HIGH', 'permanent instruction override'],
  [/\b(jailbreak|unrestricted\s*mode|developer\s*mode|god\s*mode)\b/i, 'HIGH', 'jailbreak / unrestricted-mode language'],
  [/(you\s+are|act\s+as)\s+(an?\s+)?(unrestricted|unconstrained|jailbroken|unfiltered)\s+(assistant|ai|model|chatbot)|do\s+anything\s+without\s+(rules|restrictions|limits)/i, 'HIGH', 'claims to bypass restrictions'],
  [/\bdo\s+n[o0]t\s+(tell|inform|reveal|mention|disclose)\s+(the\s+user|your\s+creator|anyone|the\s+human)\b/i, 'HIGH', 'instructs concealment from the user'],
  [/(your\s+(new|real|actual)\s+(instructions?|directives?|prompt|rules?)\s+are|here\s+are\s+your\s+new\s+instructions)/i, 'HIGH', 'attempts to redefine assistant instructions'],
  [/forget\s+(everything|all)\s+(you\s+know|your\s+(instructions?|training|guidelines|rules?))/i, 'HIGH', 'directs memory/instruction wipe'],
  [/reject\s+(your\s+)?(system|prior|previous)\s+(instructions?|prompt|guidelines?)/i, 'HIGH', 'rejection of system instruction'],

  // ---- MEDIUM: role spoofing, hidden behavior, external contact ----
  [/^(system|developer|user|assistant)\s*[:\-]\s*/im, 'MEDIUM', 'role-tag spoofing (prefixing text as a system/developer message)'],
  [/(contact|connect|send\s*(a\s*request\s*)?to|notify|call)\s+(an?\s+)?(external|remote|third[- ]party|other)\s+(server|service|endpoint|api|website|url)/i, 'MEDIUM', 'instructs agent to contact external services'],
  [/(follow|obey)\s+(only\s+)?(these|the\s+following)\s+(instructions?|rules?|commands?)/i, 'MEDIUM', 'demands obedience to page-provided instructions'],
  [/(instructions?|directives?|rules?)\s+(are\s+)?(below|ahead|in\s+this\s+page|on\s+this\s+page)/i, 'MEDIUM', 'page-contained instruction block'],
  [/\b(reward|bonus|tip)\s+(if|when)\b|will\s+be\s+rewarded/i, 'MEDIUM', 'incentive to follow page instructions'],
  [/(don'?t|do\s+not)\s+(tell|say|mention|discuss|share)\b/i, 'MEDIUM', 'concealment instruction'],

  // ---- LOW: weak / ambiguous signals ----
  [/\bignore\s+(this|the\s+above|the\s+previous)\b/i, 'LOW', 'ambiguous ignore phrasing'],
  [/\bfollow\s+the\s+(link|button|form)\b/i, 'LOW', 'generic directive wording'],
  [/^(.*)\b(skip|overlook)\s+(previous|prior)\b(.*)$/im, 'LOW', 'weak override phrasing'],
];

function base64ContainsInstruction(text) {
  // Best-effort: any base64-ish token whose decoded form contains an
  // instruction keyword → flag it. Bounded to short tokens to avoid noise.
  const tokens = text.match(/[A-Za-z0-9+/=]{16,200}/g) || [];
  for (const tok of tokens) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(tok)) continue;
    try {
      const decoded = Buffer.from(tok, 'base64').toString('utf8');
      if (/(ignore|instruction|reveal|upload|credential)/i.test(decoded)) {
        return { token: tok, decoded: decoded.slice(0, 120) };
      }
    } catch {}
  }
  return null;
}

/**
 * Scan text for suspicious patterns.
 * @param {string} text
 * @returns {{
 *   severity: 'NONE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL',
 *   findings: Array<{severity, label, snippet, context}>,
 *   quarantine: Array<{severity, label, text, context}>,   // same items; explicit channel
 *   obfuscation: {zeroWidth: boolean, base64: boolean},
 *   instruction_authority: false
 * }}
 */
function scanForPromptInjection(text) {
  const findings = [];
  const obfuscation = { zeroWidth: false, base64: false };
  if (!text) {
    return { severity: 'NONE', findings: [], quarantine: [], obfuscation, instruction_authority: false };
  }

  if (ZERO_WIDTH.test(text)) {
    obfuscation.zeroWidth = true;
    findings.push({
      severity: 'MEDIUM',
      label: 'zero-width character obfuscation',
      snippet: text.slice(0, 80) + (text.length > 80 ? '…' : ''),
      context: 'page text contains invisible characters often used to hide instructions',
    });
  }

  const compact = text.replace(/\s+/g, ' ').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  // Separator-obfuscated keywords: "i.g.n.o.r.e", "i-g-n-o-r-e", "r e v e a l"
  for (const kw of ['ignore', 'disregard', 'reveal', 'exfiltrate', 'instructions', 'jailbreak']) {
    const re = new RegExp(`\\b${kw.split('').join('[.\\-_ ]')}\\b`, 'i');
    if (re.test(compact)) {
      findings.push({
        severity: 'HIGH',
        label: `obfuscated instruction keyword "${kw}"`,
        snippet: compact.slice(0, 100) + (compact.length > 100 ? '…' : ''),
        context: 'keyword split with separators to evade scanners',
      });
    }
  }

  const hidden64 = base64ContainsInstruction(text);
  if (hidden64) {
    obfuscation.base64 = true;
    findings.push({
      severity: 'MEDIUM',
      label: 'base64-encoded instruction-like text',
      snippet: hidden64.token.slice(0, 60) + '…',
      context: `decodes to: ${hidden64.decoded}…`,
    });
  }

  for (const [re, severity, label] of RULES) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 40);
      const snippet = text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
      findings.push({
        severity,
        label,
        snippet: snippet.length > 160 ? snippet.slice(0, 160) + '…' : snippet,
        context: `pattern matched: /${re.source.slice(0, 60)}/`,
      });
    }
  }

  if (findings.length === 0) {
    return { severity: 'NONE', findings: [], quarantine: [], obfuscation, instruction_authority: false };
  }

  const order = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  let severity = findings.reduce((acc, f) => (order[f.severity] > order[acc] ? f.severity : acc), 'LOW');
  // CRITICAL when override + secret/exfil combine
  const hasOverride = findings.some((f) => f.severity === 'CRITICAL' && /override|ignore|disregard/.test(f.label));
  const hasExfil = findings.some((f) => /secret|credential|upload|exfiltrat|filesystem|local file|system prompt/.test(f.label));
  if (hasOverride && hasExfil) severity = 'CRITICAL';

  return {
    severity,
    findings,
    quarantine: findings.map((f) => ({ severity: f.severity, label: f.label, text: f.snippet, context: f.context })),
    obfuscation,
    instruction_authority: false,
  };
}

/** Convenience: severity of the first scan hit on multiple text blocks. */
function scanBlocks(blocks) {
  let worst = 'NONE';
  let combined = [];
  for (const b of blocks) {
    if (!b) continue;
    const r = scanForPromptInjection(String(b));
    combined = combined.concat(r.findings);
    const order = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    if (order[r.severity] > order[worst]) worst = r.severity;
  }
  return { severity: worst, findings: combined, quarantine: combined, instruction_authority: false };
}

module.exports = { scanForPromptInjection, scanBlocks };