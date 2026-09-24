'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { forgeActionScript, forgeScrollScript } = require('../../src/page-actions');
const { hashEffectProof } = require('../../src/engine/action-policy');

function harness(onDialog = () => {}) {
  const form = { action: 'https://example.com/search', method: 'get' };
  const events = [];
  function field(tag, name) {
    const el = { tagName: tag, type: tag === 'SELECT' ? 'select-one' : 'text', name, id: name,
      value: '', innerText: '', disabled: false, isConnected: true, form,
      checkVisibility: () => true, getClientRects: () => [{ x: 10, y: 10, width: 100, height: 20 }],
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 20 }),
      contains: other => other === el, closest: selector => selector === 'form' ? form : null,
      getAttribute: key => key === 'aria-label' ? name : null,
      dispatchEvent: event => { events.push({ name, type: event.type }); }, focus: () => { page.document.activeElement = el; },
    };
    if (tag === 'SELECT') el.options = [{ value: 'red', disabled: false }, { value: 'blue', disabled: false }];
    return el;
  }
  const page = { window: { __forgeAgent: { nodes: new Map() } },
    document: { activeElement: null, elementFromPoint: () => page.window.__forgeAgent.nodes.get(1),
      querySelectorAll: selector => selector === 'input, select, textarea' ? [query, ssn, choice] : [],
      getElementById: () => null },
    Event: class { constructor(type) { this.type = type; } }, URL, Map, TextEncoder,
    location: { href: 'https://example.com/page', origin: 'https://example.com', pathname: '/page', search: '' },
    innerWidth: 800, innerHeight: 600 };
  const query = field('INPUT', 'query'), ssn = field('INPUT', 'ssn'), choice = field('SELECT', 'color');
  page.window.__forgeAgent.nodes.set(1, query);
  let inserted = 0;
  const wc = { getURL: () => page.location.href, isDestroyed: () => false,
    executeJavaScript: async source => vm.runInNewContext(source, page),
    insertText: async value => { inserted++; if (page.document.activeElement) page.document.activeElement.value += value; } };
  const tab = { wc }; let active = tab;
  const dialogs = [];
  const context = { activeTab: () => active, forgeActionScript, forgeScrollScript, hashEffectProof, require,
    requireAgentTab: async () => { if (active !== tab) throw Error('agent tab switched'); return tab; },
    chromeWin: { isDestroyed: () => false }, log: { log: () => {} },
    dialog: { showMessageBox: async (_win, options) => {
      dialogs.push(options); onDialog({ page, query, ssn, choice, form, tab }); return { response: 1 };
    } } };
  const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const begin = source.indexOf('const agentClickApprovals = new WeakMap();');
  const end = source.indexOf('let smokeDone = false;', begin);
  if (begin < 0 || end < 0) throw new Error('main-process action functions not found');
  vm.runInNewContext(source.slice(begin, end) + '\nthis.approve = approveAgentAction; this.act = executeAgentAction;', context);
  return { ...context, page, query, ssn, choice, tab, form, dialogs, events,
    swapTab: () => { active = { wc }; }, inserted: () => inserted };
}
const action = (kind = 'fill', value = 'synthetic search') => ({ kind, targetIndex: 1, value, label: 'query' });
const info = action => ({ action, policy: { why: 'editing may have effects' } });

module.exports = [
  { name: 'associated Password label vetoes native-approved fill and label swaps invalidate inspection', gate: 'C1', fn: async a => {
    const target = action();
    const sensitive = harness();
    sensitive.query.labels = [{ textContent: 'Password' }];
    a.strictEqual(await sensitive.approve(info(target)), false);
    a.strictEqual((await sensitive.act(target)).ok, false);
    a.strictEqual(sensitive.query.value, '');

    const during = harness(({ query }) => { query.labels[0].textContent = 'Password'; });
    during.query.labels = [{ textContent: 'Username' }];
    a.strictEqual(await during.approve(info(action())), false);
    a.strictEqual(during.query.value, '');

    const after = harness();
    after.query.labels = [{ textContent: 'Username' }];
    const approved = action();
    a.strictEqual(await after.approve(info(approved)), true);
    after.query.labels[0].textContent = 'Password';
    a.strictEqual((await after.act(approved)).ok, false);
    a.strictEqual(after.query.value, '');

    const benign = harness(({ query }) => { query.labels[0].textContent = 'Profile name'; });
    benign.query.labels = [{ textContent: 'Username' }];
    a.strictEqual(await benign.approve(info(action())), false, 'benign label mutation must invalidate native approval');
  } },
  { name: 'fill requires a native approval and consumes it once', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.query.value, '');
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(h.dialogs[0].detail.includes('Field: INPUT name=query id=query'));
    a.ok(h.dialogs[0].detail.includes('Destination: https://example.com/search'));
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(h.query.value, 'synthetic search');
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.query.value, 'synthetic search');
  } },
  { name: 'fill rejects index substitution query to ssn during native dialog', gate: 'C1', fn: async a => {
    const h = harness(({ page, ssn }) => page.window.__forgeAgent.nodes.set(1, ssn));
    const target = action();
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.ssn.value, ''); a.strictEqual(h.inserted(), 0);
  } },
  { name: 'fill rejects index substitution after approval and sensitive destination even with forged proof', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    h.page.window.__forgeAgent.nodes.set(1, h.ssn);
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual((await h.act({ ...target, value: JSON.stringify({ forgeApproval: true }) })).ok, false);
    a.strictEqual(h.ssn.value, ''); a.strictEqual(h.inserted(), 0);
  } },
  { name: 'direct native approval for ssn is refused regardless of human allow', gate: 'C1', fn: async a => {
    const h = harness(); h.page.window.__forgeAgent.nodes.set(1, h.ssn);
    const target = action();
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual((await h.act(target)).ok, false); a.strictEqual(h.ssn.value, '');
  } },
  { name: 'fill refuses a replaced document at the same URL', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    h.page.window = { __forgeAgent: { nodes: new Map([[1, h.query]]) } };
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.query.value, '');
  } },
  { name: 'concurrent fills cannot reuse a single approval', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    const results = await Promise.all([h.act(target), h.act(target)]);
    a.strictEqual(results.filter(r => r.ok).length, 1);
    a.strictEqual(h.query.value, 'synthetic search');
  } },
  { name: 'fill binds immutable kind value tab field metadata and form effect', gate: 'C1', fn: async a => {
    for (const mutate of [
      (h, target) => { target.value = 'changed'; },
      (h, target) => { target.kind = 'select'; },
      h => h.swapTab(),
      h => { h.query.name = 'other'; },
      h => { h.form.action = 'https://other.test/collect'; },
    ]) {
      const h = harness(); const target = action();
      a.strictEqual(await h.approve(info(target)), true);
      mutate(h, target);
      a.strictEqual((await h.act(target)).ok, false);
      a.strictEqual(h.query.value, ''); a.strictEqual(h.inserted(), 0);
    }
  } },
  { name: 'select requires approval bound to node value and effect, once', gate: 'C1', fn: async a => {
    const h = harness(); h.page.window.__forgeAgent.nodes.set(1, h.choice);
    const target = action('select', 'blue');
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(await h.approve(info(target)), true);
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(h.choice.value, 'blue');
    a.strictEqual((await h.act(target)).ok, false);
  } },
  { name: 'select refuses swapped node, option and effect during or after dialog', gate: 'C1', fn: async a => {
    for (const mutate of [
      ({ page, query }) => page.window.__forgeAgent.nodes.set(1, query),
      ({ choice }) => { choice.options[1].disabled = true; },
      ({ form }) => { form.method = 'post'; },
    ]) {
      const h = harness(); h.page.window.__forgeAgent.nodes.set(1, h.choice);
      const target = action('select', 'blue');
      const mutation = { page: h.page, query: h.query, choice: h.choice, form: h.form };
      // Approval has to notice a mutation introduced while the modal is open.
      const during = harness(mutate);
      during.page.window.__forgeAgent.nodes.set(1, during.choice);
      a.strictEqual(await during.approve(info(action('select', 'blue'))), false);
      a.strictEqual(await h.approve(info(target)), true);
      mutate(mutation);
      a.strictEqual((await h.act(target)).ok, false);
      a.strictEqual(h.choice.value, '');
    }
  } },
];