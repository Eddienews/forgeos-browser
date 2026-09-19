/*
 * agent-loop.js — observe → decide → act, until the goal is met.
 *
 * The loop is pure: it receives `observe`, `decide` and `act` as functions, so
 * the whole state machine is testable without a browser and reusable from both
 * the Agent API and the desktop UI.
 *
 * Vocabulary of outcomes (deliberately distinct — they mean different things to
 * a caller): 
 *   done     — the decider judged the goal met. Verify before trusting.
 *   stalled  — the step budget ran out, or an action changed nothing.
 *   blocked  — the page resisted (login wall, captcha, refusal), or a human
 *              declined an action that required approval.
 *   error    — the loop itself failed.
 *
 * A stalled/blocked result is NOT a retry signal: it means "needs a different
 * goal or a human", which is why it is reported separately from failure.
 */
'use strict';

const { normalizeSnapshot, describeSnapshot } = require('./page-snapshot');
const { classifyAction } = require('./action-policy');
const { filterObservation, filterSummary } = require('./snapshot-filter');

const OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'];

const DEFAULTS = {
  maxSteps: 12,
  filterObservations: true,
  // Two identical fingerprints in a row after an action means the action did
  // nothing (or the page ignored it). Retrying would loop forever.
  stallLimit: 2,
  settleMs: 250,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one goal against one page.
 *
 * @param {object} deps
 * @param {string} deps.goal
 * @param {() => Promise<object>} deps.observe   read the page once (raw payload)
 * @param {(action: object) => Promise<object>} deps.act  execute an action
 * @param {(ctx: object) => Promise<object>} deps.decide  choose the next operation
 * @param {(info: object) => Promise<boolean>} [deps.requestApproval] human gate
 * @param {(line: string) => void} [deps.log]
 * @param {object} [options]
 */
async function runGoal(deps, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { goal } = deps;
  const log = deps.log || (() => {});
  const history = [];
  const evidence = [];
  // Per-invocation: two goals may run at once, so this must never be module state.
  let lastValue = null;
  let filterTotals = { injections: 0, redactions: 0 };

  const finish = (status, result, note) => ({
    status, result: result || null, note: note || '',
    steps: history.length, evidence, history,
    filter: { injections: filterTotals.injections, redactions: filterTotals.redactions },
  });
  const lastResultValue = () => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].value) return history[i].value;
    }
    return lastValue;
  };

  if (!goal || typeof goal !== 'string') return finish('error', null, 'a goal is required');
  if (typeof deps.observe !== 'function' || typeof deps.act !== 'function' || typeof deps.decide !== 'function') {
    return finish('error', null, 'observe, act and decide are all required');
  }

  let previousFingerprint = null;
  let stalls = 0;

  for (let step = 1; step <= cfg.maxSteps; step += 1) {
    // ---- OBSERVE ----------------------------------------------------------
    let raw;
    try {
      raw = await deps.observe();
    } catch (err) {
      return finish('error', null, `observation failed: ${String(err && err.message || err).slice(0, 200)}`);
    }
    const snapshot = normalizeSnapshot(raw);

    // The model must never receive a page's instructions as instructions.
    if (cfg.filterObservations) {
      const filtered = filterObservation(snapshot);
      snapshot.text = filtered.text;
      // Deliberately NOT attached: filtered.injections[].excerpt. That excerpt
      // is the planted text itself, and this snapshot is what the decider reads.
      // The loop surfaces counts; the excerpts stay in the audit trail.
      snapshot.filterReport = {
        safe: filtered.safe,
        removed: filtered.removed,
        injectionCount: filtered.injections.length,
        redactions: [...new Set(filtered.redactions)],
      };
      filterTotals.injections += filtered.injections.length;
      filterTotals.redactions += filtered.redactions.length;
      if (filtered.injections.length || filtered.redactions.length) {
        log(`step ${step}: observation filtered — ${filterSummary(filtered)}`);
      }
    }

    // The goal MUST travel with the observation. Without it a decider that
    // reasons about the goal (the model-backed one builds its state from it)
    // receives `undefined` and answers as if no goal had been set — which showed
    // up live as choices with no relationship to what was asked, at confidence
    // 0.4-0.6. The decider contract is {goal, snapshot, history, step}.
    const observation = { goal, snapshot, summary: describeSnapshot(snapshot), history, step };
    log(`step ${step}: ${observation.summary}`);

    // Same page as last time, after an action? The action had no effect.
    if (previousFingerprint && snapshot.fingerprint === previousFingerprint) {
      stalls += 1;
      if (stalls >= cfg.stallLimit) {
        return finish('stalled', lastResultValue(),
          `the page did not change after ${stalls} actions`);
      }
    } else {
      stalls = 0;
    }
    previousFingerprint = snapshot.fingerprint;

    // ---- DECIDE -----------------------------------------------------------
    let decision;
    try {
      decision = await deps.decide(observation);
    } catch (err) {
      return finish('error', null, `decision failed: ${String(err && err.message || err).slice(0, 200)}`);
    }
    if (!decision || !decision.operation) {
      // Carry the decider's own reason through: "no listed element serves the
      // goal" tells the caller far more than "the decider returned no operation".
      const why = decision && decision.reasoning ? String(decision.reasoning).slice(0, 300) : 'the decider returned no operation';
      return finish('stalled', lastResultValue(), why);
    }
    const operation = String(decision.operation).toUpperCase();
    if (!OPERATIONS.includes(operation)) {
      return finish('stalled', lastResultValue(), `unknown operation "${operation}"`);
    }

    if (operation === 'DONE') {
      return finish('done', decision.result != null ? String(decision.result) : lastResultValue(),
        decision.reasoning || 'the decider judged the goal met');
    }
    if (operation === 'BLOCKED') {
      return finish('blocked', null, decision.reasoning || 'the page resisted the goal');
    }

    // ---- ACT --------------------------------------------------------------
    const action = toAction(operation, decision, snapshot);
    if (action.error) return finish('stalled', lastResultValue(), action.error);

    // Policy gate: consequence, not mechanism, decides what needs a human.
    const policy = classifyAction(action);
    let approved = true;
    if (policy.risk === 'approval') {
      if (typeof deps.requestApproval !== 'function') {
        return finish('blocked', null, `action requires approval (${policy.why}) and no approver is available`);
      }
      approved = await deps.requestApproval({ action, policy, goal, step });
      if (!approved) {
        evidence.push({ step, operation, target: action.targetIndex, value: action.value, outcome: 'denied', why: policy.why });
        return finish('blocked', null, `a human declined this action: ${policy.why}`);
      }
    }

    let outcome;
    try {
      outcome = await deps.act(action);
    } catch (err) {
      outcome = { ok: false, reason: String(err && err.message || err).slice(0, 200) };
    }

    const entry = {
      step, operation, target: action.targetIndex == null ? null : action.targetIndex,
      value: action.value == null ? null : String(action.value).slice(0, 120),
      risk: policy.risk, why: policy.why,
      outcome: outcome && outcome.ok ? 'ok' : 'refused',
      detail: outcome && outcome.ok ? (outcome.detail || null) : (outcome && outcome.reason) || 'no reason given',
      label: action.label || null,
    };
    history.push(entry);
    evidence.push(entry);
    log(`step ${step}: ${operation}${entry.target ? ` [${entry.target}]` : ''} → ${entry.outcome}${entry.detail ? ` (${entry.detail})` : ''}`);

    // A refusal that is not a page change means the index went stale: re-observe.
    if (entry.outcome === 'refused') {
      previousFingerprint = null;
      stalls += 1;
      if (stalls >= cfg.stallLimit * 2) {
        return finish('stalled', lastResultValue(), `repeatedly refused: ${entry.detail}`);
      }
    }

    // When the decider states the answer in the action itself, keep it: a task
    // that reads a value and then goes DONE must still report the value.
    if (decision.result != null && String(decision.result).trim()) {
      lastValue = String(decision.result);
    }

    if (cfg.settleMs) await sleep(cfg.settleMs);
  }

  return finish('stalled', lastValue, `step budget of ${cfg.maxSteps} exhausted`);
}

/** Map a decision onto a concrete action, validating the target exists. */
function toAction(operation, decision, snapshot) {
  const index = decision.target == null ? null : Number(decision.target);
  const needsElement = ['CLICK', 'TYPE_TEXT', 'SELECT'].includes(operation);

  if (needsElement) {
    if (!Number.isFinite(index)) return { error: `${operation} needs a target index` };
    const el = (snapshot.elements || []).find((e) => e.index === index);
    if (!el) return { error: `target [${index}] is not in this observation` };
    if (operation === 'CLICK' && el.kind !== 'click') return { error: `[${index}] is not clickable (${el.kind})` };
    if (operation === 'TYPE_TEXT' && el.kind !== 'fill') return { error: `[${index}] is not fillable (${el.kind})` };
    if (operation === 'SELECT' && el.kind !== 'select') return { error: `[${index}] is not selectable (${el.kind})` };
    return {
      kind: operation === 'CLICK' ? 'click' : operation === 'TYPE_TEXT' ? 'fill' : 'select',
      targetIndex: index,
      value: operation === 'SELECT' ? (decision.option_value != null ? decision.option_value : decision.value) : decision.value,
      label: el.label,
      // Risk signals come from the live element, not the model's own claim.
      signal: { label: el.label, href: el.href || '', isForm: el.kind === 'fill', isSubmit: false, type: el.role === 'textbox' ? 'text' : '' },
    };
  }

  if (operation === 'SCROLL_UP') return { kind: 'scroll', direction: 'up' };
  if (operation === 'SCROLL_DOWN') return { kind: 'scroll', direction: 'down' };
  if (operation === 'WAIT') return { kind: 'wait' };
  return { error: `unsupported operation ${operation}` };
}

/**
 * Deterministic fallback decider: no model, no network, no cost.
 *
 * It is intentionally simple — it exists so the loop works (and can be tested)
 * without an inference key, and as a safety net when one is unavailable. It
 * never invents: it only picks from elements the snapshot actually contains.
 */
function createHeuristicDecider() {
  return async function decide({ snapshot, history, step }) {
    const text = `${snapshot.text}\n${snapshot.title}`.toLowerCase();
    const done = (result, reasoning) => ({ operation: 'DONE', result, reasoning });

    const fillable = (snapshot.elements || []).filter((e) => e.kind === 'fill' && !e.current_value);
    const clickable = (snapshot.elements || []).filter((e) => e.kind === 'click');

    // 1. A search box, if the goal mentions searching.
    const wantsSearch = /\b(search|buscar|procurar|pesquisar|find|localizar)\b/.test(text) || /search|buscar|pesquisar/.test(snapshot.url);
    if (wantsSearch && step === 1) {
      const box = fillable.find((e) => /search|buscar|pesquisar|query|q\b/i.test(e.label));
      if (box) return { operation: 'TYPE_TEXT', target: box.index, value: '', reasoning: 'a search field is present' };
    }

    // 2. If the goal term already appears in the page text, we may be done.
    const terms = String(snapshot.text || '').toLowerCase();
    if (terms.length > 40) {
      const firstSentence = terms.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 30)[0];
      if (firstSentence) return done(firstSentence.slice(0, 400), 'page text is available');
    }

    // 3. Otherwise follow the first unvisited link.
    const visited = new Set(history.filter((h) => h.operation === 'CLICK').map((h) => h.target));
    const next = clickable.find((e) => !visited.has(e.index));
    if (next) return { operation: 'CLICK', target: next.index, reasoning: 'following an unvisited control' };

    // 4. Try scrolling before giving up.
    if (snapshot.can_scroll_down) return { operation: 'SCROLL_DOWN', reasoning: 'nothing actionable in view' };

    return { operation: 'BLOCKED', reasoning: 'no actionable element and nothing left to scroll' };
  };
}

module.exports = { runGoal, createHeuristicDecider, OPERATIONS, DEFAULTS };
