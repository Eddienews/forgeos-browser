/*
 * action-policy.js — decides which agent actions may run automatically.
 *
 * The rule the whole project rests on: reading is automatic, ACTING is not
 * always. But demanding human approval for every click makes a 20-step loop
 * useless — so the line is drawn at CONSEQUENCE, not at mechanism:
 *
 *   auto      — reversible, local, no commitment: clicking a link, scrolling,
 *               waiting, choosing an option, typing into a search field.
 *   approval  — commits the user to something: submitting a form, buying,
 *               paying, deleting, logging out, downloading.
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

/** Input types that carry credentials or payment data — never auto-filled. */
const SENSITIVE_INPUT_TYPES = ['password', 'credit', 'card', 'cvv', 'cc-', 'otp'];

/**
 * Classify one action.
 * @param {{kind: string, value?: string, signal?: object}} action
 * @returns {{risk: "auto"|"approval", why: string}}
 */
function classifyAction(action) {
  const kind = action && action.kind;
  if (!kind) return { risk: 'approval', why: 'unclassified action' };

  // Never automatic: anything touching a credential or payment field.
  if (kind === 'fill') {
    const signal = action.signal || {};
    const type = String(signal.type || '').toLowerCase();
    if (SENSITIVE_INPUT_TYPES.some((t) => type.includes(t))) {
      return { risk: 'approval', why: `sensitive input type "${type}"` };
    }
    const label = String(signal.label || '').toLowerCase();
    if (/(password|senha|card|cartão|cvv|security code)/.test(label)) {
      return { risk: 'approval', why: `sensitive field label "${label.slice(0, 40)}"` };
    }
    return { risk: 'auto', why: 'typing into a non-sensitive field' };
  }

  if (kind === 'scroll' || kind === 'wait') return { risk: 'auto', why: 'no state change' };
  if (kind === 'select') return { risk: 'auto', why: 'choosing an option' };

  if (kind === 'click') {
    const signal = action.signal || {};
    if (signal.isSubmit) return { risk: 'approval', why: 'form submit button' };
    const haystack = `${signal.label || ''} ${signal.href || ''}`.toLowerCase();
    const hit = RISK_SIGNALS.find((s) => haystack.includes(s));
    if (hit) return { risk: 'approval', why: `commits the user: matched "${hit}"` };
    // A same-page anchor is the safest possible click.
    if (signal.href && signal.href.startsWith('#')) return { risk: 'auto', why: 'same-page anchor' };
    return { risk: 'auto', why: 'following a link or pressing a control' };
  }

  return { risk: 'approval', why: `unrecognised action "${kind}"` };
}

module.exports = { classifyAction, RISK_SIGNALS, SENSITIVE_INPUT_TYPES };
