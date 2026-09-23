/*
 * snapshot-filter.js — scrubs an observation BEFORE it reaches a model.
 *
 * This is the boundary that matters. Once page text is inside a prompt, the
 * model has already read it; a warning attached afterwards is advisory at best.
 * Here the page's own words are removed or neutralised on the way out, so an
 * instruction planted in a page is never delivered as an instruction.
 *
 * Two rules this module obeys:
 *   1. It filters the OBSERVATION, never the page. The user sees the real page,
 *      unmodified — this project does not rewrite sites.
 *   2. It never fabricates. Flagged spans are removed or marked, never reworded.
 *
 * The page is UNTRUSTED DATA. That is the axiom; everything here follows from it.
 */
'use strict';

/** Phrases that try to address the agent itself rather than the reader. */
const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  /\b(?:you|the\s+assistant|the\s+agent|ai)\s+(?:are|must|should|will)\s+(?:now\s+)?(?:ignore|disregard|forget|override)/i,
  /\bnew\s+instructions?\s*:/i,
  /\bsystem\s*(?:prompt|message|instruction)s?\s*[:=]/i,
  /\bassistant\s*:\s*(?:you|please|now)/i,
  /\bdo\s+not\s+(?:tell|inform|warn|mention\s+to)\s+the\s+user/i,
  /\bwithout\s+(?:telling|asking|informing|notifying)\s+the\s+user/i,
  /\b(?:exfiltrate|send|forward|post|upload)\s+(?:the\s+)?(?:user'?s?\s+)?(?:data|credentials?|cookies?|tokens?|passwords?|keys?)/i,
  /\bcall\s+(?:the\s+)?(?:api|endpoint|tool|function)\s+(?:at|with|to)\b/i,
  /\b(?:ig[n]ore|esqueça|desconsidere)\s+(?:as\s+)?(?:instru[çc][õo]es|regras)/i,
  /\binstru[çc][õo]es\s+novas\s*:/i,
  /\bn[ãa]o\s+(?:avise|informe|conte)\s+ao\s+usu[áa]rio/i,
];

/** Credential-shaped strings that must never leave the browser. */
const SECRET_PATTERNS = [
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g },
  { name: 'api key', re: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{16,}\b/gi },
  { name: 'aws access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'email+password pair', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\s*[:/]\s*\S{6,}/g },
];

const REDACTED = '[REDACTED]';

/** Apply every redaction rule to one string. */
function redactSecrets(text) {
  let out = String(text || '');
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      hits.push(name);
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
  }
  return { text: out, hits };
}

/** Find planted instructions; return which patterns fired and where. */
function scanInjection(text) {
  const flags = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    for (const re of INJECTION_PATTERNS) {
      if (re.test(line)) {
        flags.push({ line: i, excerpt: line.trim().slice(0, 160) });
        break;
      }
    }
  });
  return flags;
}

/**
 * Replace a flagged line with a marker that carries NO part of the original.
 *
 * This is the whole point of the module: the filtered text is what a model
 * reads. Echoing even a short excerpt of the planted instruction would hand it
 * back the text it must not follow. What was removed stays in the report
 * metadata (for the audit log and the human), never in the text.
 */
const REMOVAL_MARKER = '[CONTENT REMOVED: page text attempted to instruct the agent]';

function neutraliseLine() {
  return REMOVAL_MARKER;
}

/**
 * Filter one observation before a model sees it.
 * @param {{text?: string, title?: string, elements?: Array<object>}} snapshot
 * @param {{maxText?: number}} [options]
 * @returns {{text: string, title: string, redactions: string[], injections: object[], removed: number, safe: boolean}}
 */
function filterObservation(snapshot, options = {}) {
  const maxText = options.maxText || 4000;
  const flags = scanInjection(snapshot && snapshot.text);
  const titleFlags = scanInjection(snapshot && snapshot.title);
  const flaggedLines = new Set(flags.map((f) => f.line));

  let lines = String((snapshot && snapshot.text) || '').split('\n');
  let removed = 0;
  lines = lines.map((line, i) => {
    if (flaggedLines.has(i)) {
      removed += 1;
      return neutraliseLine(line);
    }
    return line;
  });

  const joined = lines.join('\n');
  const { text, hits } = redactSecrets(joined);
  // runGoal passes the normalized snapshot itself to the decider (including
  // title and its derived summary), so updating only the return value would
  // leave this metadata exposed. Filter that actual object before it is used.
  const titleResult = redactSecrets(titleFlags.length
    ? REMOVAL_MARKER : (snapshot && snapshot.title) || '');
  if (snapshot && typeof snapshot === 'object') snapshot.title = titleResult.text;
  const injections = [...flags, ...titleFlags.map((f) => ({ ...f, channel: 'title' }))]
    .map((f) => ({ ...f, excerpt: redactSecrets(f.excerpt).text }));
  const redactions = [...hits, ...titleResult.hits];

  return {
    text: text.slice(0, maxText),
    title: titleResult.text,
    redactions,
    injections,
    removed: removed + (titleFlags.length ? 1 : 0),
    safe: injections.length === 0 && redactions.length === 0,
  };
}

/** Short human-readable verdict, for the audit log and status lines. */
function filterSummary(result) {
  if (!result) return 'no filter result';
  const parts = [];
  if (result.injections && result.injections.length) {
    parts.push(`${result.injections.length} planted instruction(s) neutralised`);
  }
  if (result.redactions && result.redactions.length) {
    parts.push(`redacted: ${[...new Set(result.redactions)].join(', ')}`);
  }
  return parts.length ? parts.join('; ') : 'clean';
}

module.exports = {
  filterObservation,
  filterSummary,
  redactSecrets,
  scanInjection,
  INJECTION_PATTERNS,
  SECRET_PATTERNS,
};
