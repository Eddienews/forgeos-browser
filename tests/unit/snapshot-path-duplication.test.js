/* Path duplicates of synthetic sensitive values must never leave extraction. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { forgeSnapshotScript } = require('../../src/page-snapshot');
const { normalizeSnapshot } = require('../../src/engine/page-snapshot');
const { startAgentApi } = require('../../src/ext/agent-api');
const { runGoal } = require('../../src/engine/agent-loop');

const secret = 'fixturePathValue78';
const encoded = [...secret].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
const pageUrl = `https://example.org/profile/${secret}/view/${encoded}?session=public`;
function element(tag, { value = '', label = '', href = null, y = 10, type = '', name = '', options = [] } = {}) {
  const el = {
    tagName: tag, value, type, name, id: '', autocomplete: '', labels: [], disabled: false,
    options, selectedOptions: options.slice(0, 1),
    childNodes: [{ nodeType: 3, textContent: label }],
    getAttribute: key => key === 'href' ? href : null,
    closest: () => null, checkVisibility: () => true, contains: other => other === el,
    getClientRects: () => [{ x: 10, y, width: 80, height: 20 }],
  };
  return el;
}
function extract() {
  const nodes = [
    element('INPUT', { type: 'password', name: 'password', value: secret }),
    element('A', { label: `Read ${secret}`, href: `/next/${secret}/${encoded}`, y: 80 }),
    element('A', { label: `Later ${encoded}`, href: `/later/${encoded}`, y: 900 }),
    element('SELECT', { name: 'api_key', value: secret, y: 950,
      options: [{ value: `option-${secret}`, label: `Choice ${encoded}`, disabled: false }] }),
  ];
  return vm.runInNewContext(forgeSnapshotScript(), {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0 },
    document: { querySelectorAll: () => nodes, getElementById: () => null,
      elementFromPoint: (_x, y) => nodes.find(n => n.getClientRects()[0].y + 10 === y),
      body: { innerText: `Article ${secret} ${encoded}` }, documentElement: { scrollHeight: 1300 },
      title: `Title ${secret} ${encoded}` },
    location: { href: pageUrl }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL,
  });
}
function noLeak(assert, subject, channel) {
  const body = JSON.stringify(subject);
  assert.ok(!body.includes(secret), `${channel} leaked literal path value`);
  assert.ok(!body.toLowerCase().includes(encoded.toLowerCase()), `${channel} leaked encoded path value`);
  assert.ok(body.includes('<REDACTED>'), `${channel} must visibly redact`);
}
module.exports = [
  { name: 'DOM extraction and normalization redact literal and encoded path duplicates everywhere', gate: 'C1', fn: async assert => {
    const raw = extract();
    noLeak(assert, raw, 'DOM');
    const normalized = normalizeSnapshot(raw);
    noLeak(assert, normalized, 'normalization');
    assert.ok(normalized.elements.some(e => e.label.includes('Read')));
    assert.ok(normalized.below_fold.some(e => e.label.includes('Later')));
    assert.ok(normalized.below_fold.some(e => e.kind === 'blocked' && e.sensitive && e.option_value == null));
    assert.strictEqual(normalized.elements[0].sensitive, true);
    assert.ok(normalized.url.startsWith('https://example.org/profile/'));
  } },
  { name: 'forged raw snapshot normalization and re-normalization scrub URL, href, form action and option', gate: 'C1', fn: async assert => {
    const raw = { url: pageUrl, title: `Title ${secret}`, text: `Article ${encoded}`,
      elements: [
        { index: 1, kind: 'fill', input_type: 'password', current_value: secret, label: 'Password' },
        { index: 2, kind: 'click', label: `Read ${secret}`, href: `/next/${secret}/${encoded}` },
        { index: 3, kind: 'select', label: 'Choose', option_value: `option-${secret}`,
          form_action: `/submit/${encoded}` },
      ], below_fold: [{ index: 4, kind: 'click', label: `Later ${encoded}`, href: `/later/${secret}` }] };
    const normalized = normalizeSnapshot(raw);
    noLeak(assert, normalized, 'forged raw');
    noLeak(assert, normalizeSnapshot(normalized), 're-normalized');
  } },
  { name: 'GET /snapshot default/raw and model decider never receive path duplicates', gate: 'C1', fn: async assert => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'forge-path-regression-'));
    let api;
    try {
      api = await startAgentApi({ port: 0, baseDir: dir, observe: async () => extract(),
        requireAgentTab: async () => {}, getSnapshot: () => ({ tabs: [], session: {} }),
        readPage: async () => ({}), navigate: async () => {}, approveNavigate: async () => false });
      for (const route of ['/snapshot', '/snapshot?raw=1']) {
        const response = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: api.server.address().port, path: route,
            headers: { authorization: String.fromCharCode(66,101,97,114,101,114,32) + api.bootstrapToken } }, res => {
            let body = ''; res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
          }).on('error', reject);
        });
        assert.strictEqual(response.status, 200, response.body);
        noLeak(assert, JSON.parse(response.body), route);
      }
      let called = 0;
      const outcome = await runGoal({ goal: 'Summarize article',
        observe: async () => extract(), act: async () => ({ ok: true }),
        decide: async observation => { called++; noLeak(assert, observation.snapshot, 'model decider'); return { operation: 'DONE', reasoning: 'observed' }; },
      }, { maxSteps: 1 });
      assert.strictEqual(outcome.status, 'done', outcome.note);
      assert.strictEqual(called, 1, 'model decider must observe snapshot');
    } finally {
      if (api) await api.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } },
  { name: 'main indexed snapshot must not overwrite scrubbed URL with raw webContents URL', gate: 'C1', fn: async assert => {
    const main = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
    const body = main.slice(main.indexOf('async function readIndexedSnapshot()'), main.indexOf('// Main-process authority:', main.indexOf('async function readIndexedSnapshot()')));
    assert.ok(!/snapshot\.url\s*=\s*live/.test(body), 'raw wc.getURL override reintroduces path value');
  } },
];
