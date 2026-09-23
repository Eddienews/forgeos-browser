/* action-policy.test.js — the line between acting and asking.
 * The rule the project rests on: reading is automatic, acting is not always.
 * The line is drawn at CONSEQUENCE, not mechanism. */
'use strict';
const { classifyAction } = require('../../src/engine/action-policy');

module.exports = [
  {
    name: 'ordinary navigation and reading need no human',
    gate: 'A2',
    fn: async (assert) => {
      const cases = [
        { kind: 'click', signal: { label: 'Ver detalhes', href: '#', isAnchor: true } },
        { kind: 'scroll' },
        { kind: 'wait' },
      ];
      for (const action of cases) {
        const v = classifyAction(action);
        assert.strictEqual(v.risk, 'auto', `${JSON.stringify(action)} should be automatic (got ${v.why})`);
      }
    },
  },
  {
    name: 'anything that commits the user requires approval',
    gate: 'A2',
    fn: async (assert) => {
      const cases = [
        { kind: 'click', signal: { label: 'Comprar agora' } },
        { kind: 'click', signal: { label: 'Finalizar compra' } },
        { kind: 'click', signal: { label: 'Buy now' } },
        { kind: 'click', signal: { label: 'Pagar' } },
        { kind: 'click', signal: { label: 'Excluir conta' } },
        { kind: 'click', signal: { label: 'Delete account' } },
        { kind: 'click', signal: { label: 'Sair' } },
        { kind: 'click', signal: { label: 'Download relatório' } },
        { kind: 'click', signal: { label: 'Subscribe' } },
      ];
      for (const action of cases) {
        const v = classifyAction(action);
        assert.strictEqual(v.risk, 'approval', `${action.signal.label} must require approval`);
        assert.ok(v.why.length > 0, 'a refusal must explain itself');
      }
    },
  },
  {
    name: 'a form submit is approval even when the label looks innocent',
    gate: 'A2',
    fn: async (assert) => {
      const v = classifyAction({ kind: 'click', signal: { label: 'Enviar', isSubmit: true, isForm: true } });
      assert.strictEqual(v.risk, 'approval');
      assert.ok(/submit/i.test(v.why), 'the reason should name the signal');
    },
  },
  {
    name: 'credentials and payment fields are never filled automatically',
    gate: 'A2',
    fn: async (assert) => {
      const cases = [
        { kind: 'fill', signal: { type: 'password', label: '' } },
        { kind: 'fill', signal: { type: 'text', label: 'Senha' } },
        { kind: 'fill', signal: { type: 'text', label: 'Número do cartão' } },
        { kind: 'fill', signal: { type: 'text', label: 'CVV' } },
        { kind: 'fill', signal: { type: 'credit-card-number', label: '' } },
        { kind: 'fill', signal: { type: 'text', name: 'api_key', label: 'Access key' } },
        { kind: 'fill', signal: { type: 'text', name: 'ssn', label: 'Identity' } },
        { kind: 'fill', signal: { type: 'text', autocomplete: 'off cc-number', label: 'Number' } },
        { kind: 'fill', signal: { type: 'text', sensitive: true, label: 'Unknown' } },
        { kind: 'click', signal: { label: 'Continue', type: 'button', href: null } },
        { kind: 'click', signal: { label: 'Next', href: '/article', isAnchor: true } },
        { kind: 'click', signal: { label: 'External', href: 'https://example.org/article', isAnchor: true } },
        { kind: 'click', signal: { label: 'Unknown', href: '#%3CREDACTED%3E', isAnchor: true } },
        { kind: 'click', signal: { label: 'Continue', href: '#safe', type: 'button' } },
        { kind: 'click', signal: { label: 'Continue', href: '#safe', isAnchor: false } },
        { kind: 'click', signal: { label: 'Continue', href: '#safe', isSubmit: true, isAnchor: true } },
      ];
      for (const action of cases) {
        const v = classifyAction(action);
        assert.strictEqual(v.risk, 'approval', `${JSON.stringify(action.signal)} must require approval`);
      }
    },
  },
  {
    name: 'plain type=button Continue and cross-document anchors fail closed; only proven fragment anchors are automatic',
    gate: 'C1',
    fn: async (assert) => {
      for (const signal of [
        { label: 'Continue', type: 'button', isAnchor: false },
        { label: 'Continue', href: '#section', isAnchor: false },
        { label: 'Read', href: '/article', isAnchor: true },
        { label: 'Read', href: 'https://example.org/', isAnchor: true },
      ]) assert.strictEqual(classifyAction({ kind: 'click', signal }).risk, 'approval');
      assert.strictEqual(classifyAction({ kind: 'click', signal: { label: 'Contents', href: '#section', isAnchor: true } }).risk, 'auto');
      assert.strictEqual(classifyAction({ kind: 'fill', signal: { label: 'Search', type: 'text' } }).risk, 'approval');
      assert.strictEqual(classifyAction({ kind: 'select', signal: { label: 'Region' } }).risk, 'approval');
    },
  },
  {
    name: 'unclassified input fails closed, not open',
    gate: 'A2',
    fn: async (assert) => {
      for (const bad of [null, undefined, {}, { kind: 'teleport' }, { kind: '' }]) {
        const v = classifyAction(bad);
        assert.strictEqual(v.risk, 'approval', `${JSON.stringify(bad)} must not be treated as safe`);
      }
    },
  },
];
