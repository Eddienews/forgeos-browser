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
        { kind: 'click', signal: { label: 'Próxima página', href: '/page/2' } },
        { kind: 'click', signal: { label: 'Artigo sobre o Rosetta Stone', href: '/wiki/Rosetta_Stone' } },
        { kind: 'click', signal: { label: 'Ver detalhes', href: '#' } },
        { kind: 'scroll' },
        { kind: 'wait' },
        { kind: 'select' },
        { kind: 'fill', signal: { label: 'Buscar produtos', type: 'text' } },
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
      ];
      for (const action of cases) {
        const v = classifyAction(action);
        assert.strictEqual(v.risk, 'approval', `${JSON.stringify(action.signal)} must require approval`);
      }
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
