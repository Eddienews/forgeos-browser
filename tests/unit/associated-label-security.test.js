'use strict';
// Synthetic only: exercise the real in-page script, analyzer, loop and loopback API.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { IN_PAGE_SCRIPT, analyzeAgentView } = require('../../src/engine/agent-view');
const { forgeSnapshotScript } = require('../../src/page-snapshot');
const { normalizeSnapshot } = require('../../src/engine/page-snapshot');
const { startAgentApi } = require('../../src/ext/agent-api');
const { runGoal } = require('../../src/engine/agent-loop');
const { forgeActionScript } = require('../../src/page-actions');

const marker = 'fixtureOnlyLabel76';
const encoded = [...marker].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
const url = `https://example.org/story/${marker}/${encoded}?ref=public`;
function fixture(kind = 'associated') {
  const label = { tagName: 'LABEL', textContent: 'Password',
    childNodes: [{ nodeType: 3, textContent: 'Password' }], getAttribute: () => null };
  const field = { tagName: 'INPUT', type: 'text', name: 'ordinary', id: 'ordinary',
    value: marker, autocomplete: '', labels: kind === 'associated' ? [label] : [],
    getAttribute: key => ({ type: 'text', name: 'ordinary', id: 'ordinary', 'aria-labelledby': kind === 'aria' ? 'external-label' : null })[key] || null,
    closest: () => null, checkVisibility: () => true, disabled: false,
    getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
    contains: other => other === field, childNodes: [] };
  const link = { tagName: 'A', textContent: `Read ${marker} ${encoded}`,
    getAttribute: key => key === 'href' ? `/next/${marker}/${encoded}` : null,
    closest: () => null, checkVisibility: () => true, disabled: false,
    getClientRects: () => [{ x: 10, y: 50, width: 80, height: 20 }],
    contains: other => other === link, childNodes: [{ nodeType: 3, textContent: `Read ${marker} ${encoded}` }] };
  const nodes = { 'input, select, textarea': [field], 'a[href]': [link],
    p: [{ textContent: `Article ${marker} ${encoded}` }] };
  const document = { title: `Title ${marker} ${encoded}`,
    body: { innerText: `Article ${marker} ${encoded}` },
    documentElement: { scrollHeight: 600 },
    querySelectorAll: selector => nodes[selector] || (selector.includes('button,input,textarea,select') ? [field, link] : []),
    querySelector: () => null,
    getElementById: id => id === 'external-label' ? { tagName: 'SPAN', textContent: 'Password',
      childNodes: [{ nodeType: 3, textContent: 'Password' }], getAttribute: () => null } : null,
    elementFromPoint: (_x, y) => y < 40 ? field : link };
  const context = { document, window: { location: { href: url }, innerWidth: 800, innerHeight: 600, scrollY: 0 },
    location: { href: url }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL };
  return { context, field };
}
function noLeak(a, value, label) {
  const text = JSON.stringify(value);
  a.ok(!text.includes(marker), `${label}: literal value escaped`);
  a.ok(!text.toLowerCase().includes(encoded.toLowerCase()), `${label}: encoded value escaped`);
}
function request(api, route) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: api.server.address().port, path: route,
      headers: { authorization: 'Bearer ' + api.bootstrapToken } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}
module.exports = [
  { name: 'contenteditable password inventory protects every public read and model while prose remains readable', gate: 'C1', async fn(a) {
    const secret = 'fixtureEditable74';
    const coded = [...secret].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
    const { context } = fixture();
    const label = { tagName: 'LABEL', textContent: 'Password', getAttribute: () => null, childNodes: [{ nodeType: 3, textContent: 'Password' }] };
    const editable = { tagName: 'DIV', isContentEditable: true, textContent: secret,
      innerText: secret, getAttribute: k => k === 'contenteditable' ? 'true' : k === 'aria-labelledby' ? 'edit-label' : null,
      closest: () => null, childNodes: [], checkVisibility: () => true, disabled: false,
      getClientRects: () => [{ x: 10, y: 90, width: 80, height: 20 }], contains: x => x === editable };
    const original = context.document.querySelectorAll;
    context.document.getElementById = id => id === 'edit-label' ? label : null;
    context.document.querySelectorAll = selector => selector === '[contenteditable]'
      ? [editable] : selector === 'input, select, textarea' ? [] : selector === 'p'
        ? [{ textContent: `Article ${secret} ${coded}` }] : selector === 'a[href]'
          ? [{ tagName: 'A', textContent: `Read ${secret}`, getAttribute: k => k === 'href' ? `/next/${secret}/${coded}` : null }]
          : selector.includes('button,input,textarea,select') ? [editable] : original(selector);
    context.document.title = `Title ${secret}`;
    context.document.body.innerText = `Article ${secret} ${coded}`;
    context.window.location.href = `https://example.org/story/${secret}/${coded}`;
    context.location.href = context.window.location.href;
    const raw = vm.runInNewContext(IN_PAGE_SCRIPT, context);
    const indexed = vm.runInNewContext(forgeSnapshotScript(), context);
    const view = analyzeAgentView(raw);
    for (const item of [raw, indexed, view]) {
      a.ok(!JSON.stringify(item).includes(secret), 'literal leaked');
      a.ok(!JSON.stringify(item).toLowerCase().includes(coded.toLowerCase()), 'encoded leaked');
    }
    a.strictEqual(raw.inputs[0].sensitive, true);
    // A hidden editor's rendered text may be empty while textContent remains sensitive.
    editable.innerText = '';
    a.ok(!JSON.stringify(vm.runInNewContext(IN_PAGE_SCRIPT, context)).includes(secret));
    a.ok(!JSON.stringify(vm.runInNewContext(forgeSnapshotScript(), context)).includes(secret));
    editable.innerText = secret;
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'forge-editable-'));
    let api;
    try {
      api = await startAgentApi({ port: 0, baseDir: dir, requireAgentTab: async () => {},
        getSnapshot: () => ({ tabs: [], session: {} }), readPage: async () => view,
        observe: async () => indexed, navigate: async () => {}, approveNavigate: async () => false });
      for (const route of ['/page', '/links', '/snapshot', '/snapshot?raw=1']) {
        const response = await request(api, route);
        a.strictEqual(response.status, 200);
        a.ok(!JSON.stringify(response.body).includes(secret), route);
        a.ok(!JSON.stringify(response.body).toLowerCase().includes(coded.toLowerCase()), route);
      }
      let seen = false;
      await runGoal({ goal: 'Read page', observe: async () => indexed, act: async () => ({ ok: true }),
        decide: async observation => { seen = true; a.ok(!JSON.stringify(observation).includes(secret));
          a.ok(!JSON.stringify(observation).toLowerCase().includes(coded.toLowerCase()));
          return { operation: 'DONE' }; } }, { maxSteps: 1 });
      a.ok(seen);
    } finally { if (api) await api.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
    Object.defineProperty(editable, 'textContent', { configurable: true, get() { throw new Error('unreadable editor'); } });
    a.throws(() => vm.runInNewContext(IN_PAGE_SCRIPT, context), /sensitive field value unavailable/);
    a.throws(() => vm.runInNewContext(forgeSnapshotScript(), context), /sensitive field value unavailable/);
    // A plain editable paragraph must not be blanked merely because it is editable.
    context.document.querySelectorAll = selector => selector.includes('contenteditable') ? [
      { tagName: 'DIV', isContentEditable: true, textContent: 'Ordinary prose', innerText: 'Ordinary prose',
        getAttribute: k => k === 'contenteditable' ? 'true' : null }] : [];
    context.document.body.innerText = 'Ordinary prose';
    a.ok(vm.runInNewContext(IN_PAGE_SCRIPT, context).bodyText.includes('Ordinary prose'));
  } },
  { name: 'action live label classification vetoes approved fill and invalidates inspect-to-recheck change', gate: 'C1', fn(a) {
    let label = 'Username';
    const el = { tagName: 'INPUT', type: 'text', name: 'ordinary', id: 'ordinary', value: '',
      isConnected: true, disabled: false, labels: [{ get textContent() { return label; } }],
      getAttribute: () => null, closest: () => null, checkVisibility: () => true,
      getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
      contains: x => x === el };
    const page = { window: { __forgeAgent: { nodes: new Map([[1, el]]) } },
      document: { elementFromPoint: () => el, getElementById: () => null,
        querySelectorAll: selector => selector === 'input, select, textarea' ? [el] : [] },
      location: { href: 'https://example.org/', origin: 'https://example.org', pathname: '/', search: '' },
      innerWidth: 800, innerHeight: 600, URL, Map };
    const run = (kind, value, proof) => vm.runInNewContext(forgeActionScript(1, kind, value, proof), page);
    const first = run('inspect', 'one', { kind: 'fill' });
    a.strictEqual(first.ok, true);
    label = 'Password';
    const second = run('recheck', 'one', { kind: 'fill' });
    a.strictEqual(second.ok, false);
    a.strictEqual(second.reason, 'sensitive_field');
    const forged = run('fill', 'synthetic', { kind: 'fill', value: 'synthetic', nonce: 'one', descriptor: first.descriptor });
    a.strictEqual(forged.reason, 'sensitive_field');
    a.strictEqual(el.value, '');
    label = 'Profile name';
    const again = run('recheck', 'one', { kind: 'fill' });
    a.strictEqual(again.ok, true, JSON.stringify(again));
    a.strictEqual(run('fill', 'synthetic', { kind: 'fill', value: 'synthetic', nonce: 'one', descriptor: first.descriptor }).ok, false);
  } },
  { name: 'associated HTML label and aria-labelledby classify ordinary text inputs at extraction and raw analyzer', gate: 'C1', fn: a => {
    for (const kind of ['associated', 'aria']) {
      const { context } = fixture(kind);
      const extracted = vm.runInNewContext(IN_PAGE_SCRIPT, context);
      noLeak(a, extracted, kind + ' extraction');
      a.strictEqual(extracted.inputs[0].sensitive, true);
      a.strictEqual(extracted.inputs[0].value, '<REDACTED>');
      const view = analyzeAgentView(extracted);
      noLeak(a, view, kind + ' analyzer');
      for (const metadata of [{ label: 'Password' }, { associatedLabels: 'Password', ariaLabel: 'Username' },
        { ariaLabelledBy: 'Password', ariaLabel: 'Username' }]) {
        const forged = analyzeAgentView({ url, title: `Title ${marker}`, inputs: [
          { type: 'text', name: 'ordinary', id: 'ordinary', ...metadata, value: marker }],
          paragraphs: [`Article ${marker}`], links: [{ href: `/next/${encoded}`, text: `Read ${marker}` }] });
        noLeak(a, forged, kind + ' forged raw');
        a.strictEqual(forged.content.inputs[0].sensitive, true);
      }
    }
  } },
  { name: 'unreadable associated label metadata fails closed rather than publishing input or path', gate: 'C1', fn: a => {
    const { context, field } = fixture();
    Object.defineProperty(field, 'labels', { get() { throw new Error('malformed label metadata'); } });
    const raw = vm.runInNewContext(IN_PAGE_SCRIPT, context);
    a.strictEqual(raw.inputs[0].metadataUncertain, true);
    a.strictEqual(raw.inputs[0].sensitive, true);
    noLeak(a, raw, 'unreadable metadata');
  } },
  { name: 'associated-label extraction blocks /page /links and model duplicates; indexed /snapshot stays redacted', gate: 'C1', async fn(a) {
    const { context } = fixture();
    const raw = vm.runInNewContext(IN_PAGE_SCRIPT, context);
    const view = analyzeAgentView(raw);
    const indexed = vm.runInNewContext(forgeSnapshotScript(), fixture().context);
    noLeak(a, indexed, 'indexed extraction');
    noLeak(a, normalizeSnapshot(indexed), 'indexed normalization');
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'forge-associated-label-'));
    let api;
    try {
      api = await startAgentApi({ port: 0, baseDir: dir, requireAgentTab: async () => {},
        getSnapshot: () => ({ tabs: [], session: {} }), readPage: async () => view,
        observe: async () => indexed, navigate: async () => {}, approveNavigate: async () => false });
      for (const route of ['/page', '/links', '/snapshot', '/snapshot?raw=1']) {
        const response = await request(api, route);
        a.strictEqual(response.status, 200, route);
        noLeak(a, response.body, route);
      }
      let calls = 0;
      const outcome = await runGoal({ goal: 'Summarize article', observe: async () => indexed,
        act: async () => ({ ok: true }), decide: async observation => {
          calls++;
          noLeak(a, observation.snapshot, 'model decider');
          return { operation: 'DONE', reasoning: 'observed' };
        } }, { maxSteps: 1 });
      a.strictEqual(outcome.status, 'done', outcome.note);
      a.strictEqual(calls, 1);
    } finally {
      if (api) await api.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } },
];
