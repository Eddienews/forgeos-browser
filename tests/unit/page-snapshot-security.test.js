/* Security regression at the raw DOM and normalized/provider boundaries. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { startAgentApi } = require('../../src/ext/agent-api');
const { forgeSnapshotScript } = require('../../src/page-snapshot');
const { normalizeSnapshot } = require('../../src/engine/page-snapshot');
const { candidatesFor } = require('../../src/engine/typesafe-decider');
const { buildQuestions } = require('../../src/engine/typesafe-decider');
const { forgeActionScript } = require('../../src/page-actions');

function node(tag, options = {}) {
  const attrs = options.attrs || {};
  const el = {
    tagName: tag, type: options.type || '', name: options.name || '', id: options.id || '',
    autocomplete: options.autocomplete || '', value: options.value || '',
    labels: [], childNodes: [{ nodeType: 3, textContent: options.label || '' }],
    disabled: false, options: options.options || [], selectedOptions: options.selectedOptions || [],
    getAttribute: (key) => attrs[key] || null,
    closest: (key) => key === 'form' ? options.form || null : null,
    getClientRects: () => [{ x: 10, y: options.y || 10, width: 80, height: 20 }],
    checkVisibility: () => true, contains: (other) => other === el,
  };
  if (options.form) el.form = options.form;
  return el;
}
function snapshot(nodes) {
  return vm.runInNewContext(forgeSnapshotScript(), {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0 },
    document: { querySelectorAll: () => nodes, elementFromPoint: (_x, y) => nodes.find(n => n.getClientRects()[0].y + 10 === y),
      getElementById: () => null, body: { innerText: 'Public article. Synthetic fixture-value-91, fixture-label-82 and fixture-query-73.' },
      documentElement: { scrollHeight: 1300 }, title: 'Public article' },
    location: { href: 'https://example.org/read?session=fixture-query-73#section' },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL,
  });
}
module.exports = [
  { name: 'sensitive indexed text control is visible but never offered for fill', gate: 'C1', fn: async a => {
    const raw = snapshot([node('INPUT', { name: 'api_key', type: 'text', value: 'fixture-value-91' })]);
    const safe = normalizeSnapshot(raw);
    a.strictEqual(raw.elements.length, 1);
    a.strictEqual(raw.elements[0].sensitive, true);
    a.notStrictEqual(raw.elements[0].kind, 'fill');
    a.notStrictEqual(safe.elements[0].kind, 'fill');
    a.deepStrictEqual(candidatesFor(safe, 'fill'), {});
    a.ok(!buildQuestions(safe, { goal: 'Search for article' }).operation.criteria.TYPE_TEXT);
    const input = node('INPUT', { name: 'api_key', type: 'text', value: 'fixture-value-91' });
    input.isConnected = true;
    const page = { window: { __forgeAgent: { nodes: new Map([[1, input]]) } },
      document: { elementFromPoint: () => input, querySelectorAll: () => [], getElementById: () => null },
      location: { href: 'https://example.org/read' }, innerWidth: 800, innerHeight: 600, URL };
    const refusal = vm.runInNewContext(forgeActionScript(1, 'fill', 'ordinary text'), page);
    a.strictEqual(refusal.reason, 'sensitive_field');
  } },
  { name: 'GET /snapshot?raw=1 never exposes synthetic field, label or URL query values', gate: 'C1', fn: async (assert) => {
    const baseDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-snapshot-security-'));
    const raw = snapshot([node('INPUT', { name: 'api_key', type: 'text', value: 'fixture-value-91',
      attrs: { 'aria-label': 'API key fixture-label-82' } })]);
    let api;
    try {
      api = await startAgentApi({ port: 0, baseDir, observe: async () => raw,
        requireAgentTab: async () => {}, // fixture represents an agent-owned tab
        getSnapshot: () => ({ tabs: [], session: {} }), readPage: async () => ({}),
        navigate: async () => {}, approveNavigate: async () => false });
      const result = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: api.server.address().port, path: '/snapshot?raw=1',
          headers: { authorization: api.bootstrapToken } }, (response) => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        }).on('error', reject);
      });
      assert.strictEqual(result.status, 200, result.body);
      for (const marker of ['fixture-value-91', 'fixture-label-82', 'fixture-query-73'])
        assert.ok(!result.body.includes(marker), `HTTP raw response exposed ${marker}`);
      assert.ok(result.body.includes('Public article'));
    } finally {
      if (api) await api.stop();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  } },
  { name: 'raw DOM and provider payload redact distinct field value, label and query, including below fold', gate: 'C1', fn: async (assert) => {
    const form = { getAttribute: (key) => key === 'action' ? '/submit?key=fixture-form-84' : key === 'method' ? 'get' : null,
      action: 'https://example.org/submit?key=fixture-form-84', method: 'get' };
    const nodes = [
      node('INPUT', { type: 'text', name: 'api_key', value: 'fixture-value-91',
        attrs: { 'aria-label': 'API key fixture-label-82' }, form }),
      node('INPUT', { type: 'text', name: 'ssn', value: 'fixture-ssn-92', y: 900,
        attrs: { 'aria-label': 'SSN fixture-below-label-83' }, form }),
      node('A', { label: 'Read article', y: 100, attrs: { href: '/read?secret=fixture-href-72' } }),
      node('BUTTON', { type: 'button', label: 'Continue', y: 140, form,
        attrs: { formaction: '/submit?auth=fixture-button-86' } }),
    ];
    const raw = snapshot(nodes);
    const safe = normalizeSnapshot(raw);
    const provider = candidatesFor(safe, 'fill');
    for (const marker of ['fixture-value-91', 'fixture-label-82', 'fixture-query-73', 'fixture-ssn-92',
      'fixture-below-label-83', 'fixture-href-72', 'fixture-form-84', 'fixture-button-86']) {
      assert.ok(!JSON.stringify(raw).includes(marker), `raw GET /snapshot exposed ${marker}`);
      assert.ok(!JSON.stringify(safe).includes(marker), `normalized snapshot exposed ${marker}`);
      assert.ok(!JSON.stringify(provider).includes(marker), `provider criteria exposed ${marker}`);
    }
    assert.ok(raw.text.includes('Public article'), 'ordinary page content remains');
    assert.ok(safe.elements.some(e => e.label === 'Read article'));
    assert.strictEqual(raw.below_fold[0].sensitive, true);
    assert.ok(safe.elements.some(e => e.form_action && e.form_method === 'get'), 'form metadata survives normalization');
  } },
  { name: 'normalization rejects forged raw sensitive metadata and query values', gate: 'C1', fn: async (assert) => {
    const raw = { url: 'https://example.org/?key=fixture-url-98', title: 'Article', text: 'Ordinary article',
      elements: [{ index: 1, kind: 'fill', input_type: 'text', field_name: 'api_key',
        current_value: 'fixture-value-91', label: 'fixture-other-label-97',
        option_value: 'fixture-option-96', href: '/go?token=fixture-href-72',
        form_action: '/submit?auth=fixture-form-84', form_method: 'POST' }],
      below_fold: [{ index: 2, kind: 'fill', input_type: 'text', field_name: 'ssn',
        label: 'fixture-below-label-83', current_value: 'fixture-ssn-92' }] };
    const safe = normalizeSnapshot(raw);
    for (const marker of ['fixture-value-91', 'fixture-other-label-97', 'fixture-option-96',
      'fixture-href-72', 'fixture-form-84', 'fixture-url-98', 'fixture-ssn-92', 'fixture-below-label-83']) {
      assert.ok(!JSON.stringify(safe).includes(marker), marker);
      assert.ok(!JSON.stringify(candidatesFor(safe, 'fill')).includes(marker), marker);
    }
    assert.strictEqual(safe.elements[0].sensitive, true);
    assert.strictEqual(safe.below_fold[0].sensitive, true);
    assert.strictEqual(safe.elements[0].form_method, 'post');
  } },
];
