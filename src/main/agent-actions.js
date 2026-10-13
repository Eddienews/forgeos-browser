/*
 * agent-actions.js — what an external agent may do to the agent-owned tab:
 * observe it, and act on one indexed element after the human approves.
 *
 * Agent capabilities (v0.11): observe -> decide -> act.
 *
 * The page is UNTRUSTED. These run through executeJavaScript on the active
 * tab's webContents, the same path cosmetic filtering already uses, and the tab
 * still receives no bridge. Reading is automatic; an action that commits the
 * user stops at a native dialog first (see action-policy.js for the line).
 *
 * Indexes are only ever resolved back to a live node immediately before acting,
 * so a stale index refuses instead of clicking whatever moved into that spot.
 */
'use strict';

const { dialog } = require('electron');
const { forgeSnapshotScript } = require('../page-snapshot');
const { forgeActionScript, forgeScrollScript } = require('../page-actions');
const { normalizeSnapshot } = require('../engine/page-snapshot');
const { compareAgentPreview, hashEffectProof } = require('../engine/action-policy');

/**
 * @param {{logger: {log: Function}, activeTab: Function, requireAgentTab: Function, chromeWin: object|null}} ctx
 *   chromeWin is read live from ctx on every call.
 */
function createAgentActions(ctx) {
  const log = ctx.logger;
  const activeTab = ctx.activeTab;
  const requireAgentTab = ctx.requireAgentTab;

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /** One atomic read of the active tab: page text plus the numbered element table. */
  async function readIndexedSnapshot() {
    const t = activeTab();
    if (!t || !t.wc || t.wc.isDestroyed()) return { error: 'no active tab' };
    try { await requireAgentTab(); }
    catch (error) { return { error: String(error.message || error).slice(0, 200) }; }
    try {
      const url = t.wc.getURL();
      const raw = await t.wc.executeJavaScript(forgeSnapshotScript(true), true);
      if (activeTab() !== t || t.wc.isDestroyed() || t.wc.getURL() !== url)
        return { error: 'page changed during observation' };
      // Raw effect fields may include private query values. Hash them in the
      // trusted process, then remove them before normalization/agent exposure.
      const effectProofHashes = new Map();
      for (const [index, proof] of raw._privateEffectProofs || []) {
        const hash = hashEffectProof(proof);
        if (Number.isSafeInteger(index) && hash) effectProofHashes.set(index, hash);
      }
      delete raw._privateEffectProofs;
      const snapshot = normalizeSnapshot(raw);
      t.lastAgentObservation = { url, snapshot, effectProofHashes };
      // The renderer has scrubbed sensitive value copies from the URL path.
      // The live webContents URL is authority for navigation, not observation.
      return snapshot;
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // Main-process authority: caller-supplied value, signal, and JSON witnesses never
  // grant an effect. WeakMap identity also prevents a copied action from replaying.
  const agentClickApprovals = new WeakMap();

  /** Execute one validated action against the active tab. */
  async function executeAgentAction(action) {
    const t = activeTab();
    const kind = action && action.kind;

    try {
      await requireAgentTab();
      if (kind === 'wait') {
        await sleepMs(Number(action.ms) || 600);
        await requireAgentTab();
        return { ok: true, detail: 'waited' };
      }
      if (kind === 'scroll') {
        const r = await t.wc.executeJavaScript(forgeScrollScript(action.direction === 'up' ? 'up' : 'down'), true);
        return { ok: !!(r && r.ok), detail: `scrollY=${r && r.y}` };
      }

      let clickProof = null;
      if (['click', 'fill', 'select'].includes(kind) && action && typeof action === 'object') {
        const bound = agentClickApprovals.get(action);
        agentClickApprovals.delete(action); // consume before any await, including a refusal
        if (bound) {
          if (bound.tab !== t || bound.wc !== t.wc || bound.url !== t.wc.getURL() ||
              bound.index !== action.targetIndex || bound.kind !== kind ||
              bound.optionIndex !== action.optionIndex ||
              bound.value !== (action.value == null ? null : String(action.value)))
            return { ok: false, reason: 'approval_required_or_stale' };
          clickProof = { nonce: bound.nonce, descriptor: bound.descriptor, kind: bound.kind,
            value: bound.value, optionIndex: bound.optionIndex,
            effectProofHash: bound.effectProofHash };
        }
      }
      const resolved = await t.wc.executeJavaScript(
        forgeActionScript(action.targetIndex, kind, action.value == null ? null : String(action.value), clickProof),
        true,
      );
      await requireAgentTab();
      if (!resolved || !resolved.ok) {
        return { ok: false, reason: (resolved && resolved.reason) || 'element not resolvable' };
      }
      if (resolved.done) return { ok: true, detail: kind === 'fill' ? 'typed' : kind === 'select' ? 'option selected' : 'clicked' };

      if (kind === 'click') {
        const point = { x: resolved.x, y: resolved.y, button: 'left', clickCount: 1 };
        t.wc.sendInputEvent({ type: 'mouseDown', ...point });
        t.wc.sendInputEvent({ type: 'mouseUp', ...point });
        return { ok: true, detail: `clicked ${resolved.x},${resolved.y}` };
      }
      return { ok: false, reason: `unsupported action kind "${kind}"` };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
  }

  /**
   * Native-dialog gate for an action that commits the user. Native, not HTML:
   * the page view is a separate native layer, so a rendered banner can end up
   * behind it, while a dialog is always visible and cannot be covered.
   */
  async function approveAgentAction(info) {
    const action = (info && info.action) || {};
    if (!ctx.chromeWin || ctx.chromeWin.isDestroyed()) {
      log.log('DENY', 'agent action approval unavailable', { reason: 'no browser window' });
      return false;
    }
    const t = activeTab();
    if (!t || !t.wc || t.wc.isDestroyed()) return false;
    try { await requireAgentTab(); } catch { return false; }
    const wc = t.wc;
    const url = wc.getURL();
    const targetIndex = action.targetIndex;
    const kind = action.kind;
    if (!['click', 'fill', 'select'].includes(kind) || !Number.isSafeInteger(targetIndex)) return false;
    if ((kind === 'fill' || kind === 'select') && action.value == null) return false;
    const value = action.value == null ? null : String(action.value);
    const optionIndex = action.optionIndex;
    // A model or API client never supplies the target proof. The last indexed
    // observation lives in the main process and must still be the one the agent
    // decided from. Another observation/tab navigation invalidates the proposal.
    const binding = t.lastAgentObservation;
    if (t.agentOwned && (!binding || binding.url !== url ||
        binding.snapshot.fingerprint !== action.fingerprint ||
        !binding.effectProofHashes || !binding.effectProofHashes.has(targetIndex) ||
        binding.snapshot.elements.filter(el => el.index === targetIndex && el.kind === kind &&
          (kind !== 'select' || (String(el.option_value) === value &&
            (action.optionIndex == null || el.option_index === action.optionIndex)))).length !== 1)) {
      log.log('DENY', 'agent action preview invalidated', { reason: 'observation changed' });
      return false;
    }
    let nonce, descriptor, display, previewLabel, inspectedEffectHash;
    nonce = require('crypto').randomBytes(24).toString('hex');
    try {
      const inspected = await wc.executeJavaScript(forgeActionScript(targetIndex, 'inspect', nonce, { kind }), true);
      if (!inspected || !inspected.ok || action.targetIndex !== targetIndex || action.kind !== kind ||
          action.optionIndex !== optionIndex ||
          (action.value == null ? null : String(action.value)) !== value ||
          activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url) return false;
      descriptor = inspected.descriptor;
      display = inspected.display;
      if (!descriptor || !display) return false;
      inspectedEffectHash = hashEffectProof(inspected.effectProof);
      if (!inspectedEffectHash) return false;
      previewLabel = display.label;
      if (t.agentOwned) {
        const observed = binding.snapshot.elements.find(el => el.index === targetIndex &&
          (kind !== 'select' || (String(el.option_value) === value &&
            (action.optionIndex == null || el.option_index === action.optionIndex))));
        previewLabel = observed.label || previewLabel;
        const changes = compareAgentPreview(observed, inspected, binding.snapshot.url, kind,
          binding.effectProofHashes.get(targetIndex));
        if (kind === 'select' && (!Array.isArray(descriptor.options) ||
            descriptor.options.filter(option => option[0] === value && !option[1]).length !== 1 ||
            (action.optionIndex != null && (!Number.isSafeInteger(action.optionIndex) ||
              !descriptor.options[action.optionIndex] || descriptor.options[action.optionIndex][0] !== value ||
              descriptor.options[action.optionIndex][1]))))
          changes.push('proposed option');
        if (changes.length || t.lastAgentObservation !== binding) {
          log.log('DENY', 'agent action preview invalidated', { changed: changes.join(', ') || 'observation changed' });
          await dialog.showMessageBox(ctx.chromeWin, {
            type: 'warning', title: 'ForgeOS Browser — action changed',
            message: 'The agent action changed since it was observed. Approval expired.',
            detail: `Changed: ${changes.join(', ') || 'page observation'}. Re-observe before trying again.`,
            buttons: ['Close'], defaultId: 0, cancelId: 0, noLink: true,
          });
          return false;
        }
      }
    } catch { return false; }
    const result = await dialog.showMessageBox(ctx.chromeWin, {
      type: 'warning',
      title: 'ForgeOS Browser — agent action request',
      message: `Action preview — an external agent wants to ${kind === 'fill' ? 'type into' : kind === 'select' ? 'select an option in' : 'activate'} an element.`,
      detail: `Element: [${action.targetIndex}] ${previewLabel || '(unlabelled element)'}\n` +
        `Current page: ${display.pageUrl}\nDestination: ${display.destination}\n` +
        `Form method: ${display.formMethod || '(not a form)'}\n` +
        (t.agentOwned ? 'Since observation: browser-held target/effect witness matched.\n' :
          'Since observation: unavailable in this test context.\n') +
        (kind !== 'click' ? `Field: ${descriptor.tag} name=${display.fieldName || '(none)'} id=${display.fieldId || '(none)'}\n` : '') +
        'JavaScript event handlers may have additional unknown side effects.\n' +
        (kind !== 'click' ? 'The proposed text is hidden for privacy.\n' : '') +
        '\nWhy this needs you: this interaction may change the page or submit data.\n' +
        '\nAllow only if you asked for this.',
      buttons: ['Deny', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    let allowed = result.response === 1;
    if (allowed && descriptor) {
      try {
        if (action.targetIndex !== targetIndex || action.kind !== kind || action.optionIndex !== optionIndex ||
            (action.value == null ? null : String(action.value)) !== value ||
            activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url ||
            (t.agentOwned && t.lastAgentObservation !== binding)) allowed = false;
        else {
          const current = await wc.executeJavaScript(forgeActionScript(targetIndex, 'recheck', nonce, { kind }), true);
          if (!current || !current.ok || action.targetIndex !== targetIndex ||
              action.optionIndex !== optionIndex ||
              action.kind !== kind || (action.value == null ? null : String(action.value)) !== value ||
              JSON.stringify(current.descriptor) !== JSON.stringify(descriptor) ||
              hashEffectProof(current.effectProof) !== inspectedEffectHash ||
              (t.agentOwned && hashEffectProof(current.effectProof) !== binding.effectProofHashes.get(targetIndex)) ||
              activeTab() !== t || wc.isDestroyed() || wc.getURL() !== url) allowed = false;
        }
      } catch { allowed = false; }
      if (allowed) {
        try { await requireAgentTab(); } catch { allowed = false; }
        if (allowed) agentClickApprovals.set(action, { tab: t, wc, url, index: targetIndex,
          kind, value, optionIndex, nonce, descriptor, effectProofHash: inspectedEffectHash });
      }
    }
    log.log(allowed ? 'ALLOW' : 'DENY', 'agent action human decision', {
      kind: action.kind, label: previewLabel, why: 'interaction requires approval', decision: allowed ? 'allow' : 'deny',
    });
    return allowed;
  }

  return { readIndexedSnapshot, executeAgentAction, approveAgentAction };
}

module.exports = { createAgentActions };
