/*
 * action-policy.js — decides which agent actions may run automatically.
 *
 * The rule the whole project rests on: reading is automatic, acting requires
 * approval unless the effect is tightly bounded. Until live destination and
 * script-side-effect containment are complete, conservative defaults apply:
 *
 *   auto      — reading, scrolling, waiting, same-page fragment anchors.
 *   approval  — every other click, selection, or fill. A harmless-looking
 *               control may execute JavaScript or navigate to an unsafe host.
 *
 * The link destination still requires a live safety gate; approval is not a
 * substitute for validating the target just before acting.
 *
 * This list is DATA, not code (same convention as the blocklists): editing it
 * must never require touching the decision logic.
 */
'use strict';

/** Labels/targets that commit the user to something. Substring, lowercase. */
const RISK_SIGNALS = [
  // commerce
  'buy', 'purchase', 'checkout', 'pay', 'payment', 'order', 'comprar', 'pagar',
  'finalizar compra', 'carrinho', 'cart',
  // destructive
  'delete', 'remove', 'excluir', 'remover', 'apagar', 'unsubscribe', 'cancel subscription',
  // account / session
  'sign out', 'log out', 'logout', 'sair', 'encerrar sessão', 'delete account',
  // commitment
  'submit', 'send', 'post', 'publish', 'confirm', 'enviar', 'publicar', 'confirmar',
  'aceitar', 'agree', 'subscribe', 'assinar', 'transfer', 'withdraw',
  // files
  'download', 'baixar',
];

const { classifyField } = require('./sensitive-fields');

/** Input types that carry credentials or payment data — kept for compatibility. */
const SENSITIVE_INPUT_TYPES = ['password', 'credit', 'card', 'cvv', 'cc-', 'otp'];

/**
 * Classify one action.
 * @param {{kind: string, value?: string, signal?: object}} action
 * @returns {{risk: "auto"|"approval", why: string}}
 */
function classifyAction(action) {
  const kind = action && action.kind;
  if (!kind) return { risk: 'approval', why: 'unclassified action' };

  // A field's semantic classification must not diverge from the raw snapshot.
  if (kind === 'fill') {
    const signal = action.signal || {};
    const sensitive = !!signal.sensitive || classifyField({
      type: signal.type || signal.input_type, name: signal.name || signal.field_name,
      id: signal.id, autocomplete: signal.autocomplete, ariaLabel: signal.label,
    }).sensitive;
    return { risk: 'approval', why: sensitive ? 'sensitive field' : 'editing a control may have side effects' };
  }

  if (kind === 'scroll' || kind === 'wait') return { risk: 'auto', why: 'no state change' };
  if (kind === 'select') return { risk: 'approval', why: 'selecting a control may have side effects' };

  if (kind === 'click') {
    const signal = action.signal || {};
    if (signal.isSubmit) return { risk: 'approval', why: 'form submit button' };
    const haystack = `${signal.label || ''} ${signal.href || ''}`.toLowerCase();
    const hit = RISK_SIGNALS.find((s) => haystack.includes(s));
    if (hit) return { risk: 'approval', why: `commits the user: matched "${hit}"` };
    // Only a plain fragment anchor can bypass approval. Links to other pages
    // can resolve to private addresses, and buttons may execute arbitrary JS.
    if (signal.isAnchor === true && !signal.type && !signal.isForm && /^#[-\w]*$/.test(String(signal.href || '')))
      return { risk: 'auto', why: 'same-page anchor' };
    return { risk: 'approval', why: 'navigation or control with unknown consequences' };
  }

  return { risk: 'approval', why: `unrecognised action "${kind}"` };
}

module.exports = { classifyAction, RISK_SIGNALS, SENSITIVE_INPUT_TYPES };
