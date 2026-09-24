/* Focused live-DOM regression: action-time checks, not request claims. */
'use strict';
const vm = require('vm');
const { forgeActionScript } = require('../../src/page-actions');
const { forgeSnapshotScript } = require('../../src/page-snapshot');

function makeElement(tag, opts = {}) {
  const attributes = { ...(opts.attributes || {}) };
  return {
    tagName: tag, type: opts.type === undefined && tag === 'BUTTON' ? 'submit' : (opts.type || ''),
    name: opts.name || '', id: opts.id || '',
    autocomplete: opts.autocomplete || '', value: opts.value || '',
    innerText: opts.label || '', labels: [], childNodes: [], options: [],
    disabled: false, isConnected: true,
    getAttribute: (key) => attributes[key] || null,
    closest: (selector) => selector === 'form' && opts.inForm ? {} : null,
    getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 20 }),
    checkVisibility: () => true,
    contains: (other) => other === node,
    focus: () => {}, click: () => { opts.clicks.count += 1; },
  };
  function node() {}
}
function runScript(source, node, store = { nodes: new Map([[1, node]]) }) {
  node.contains = (other) => other === node;
  const context = {
    window: { __forgeAgent: store, innerWidth: 800, innerHeight: 600, scrollY: 0 },
    document: { elementFromPoint: () => node, querySelectorAll: () => [node],
      body: { innerText: 'Public page' }, documentElement: { scrollHeight: 600 }, title: 'Page' },
    location: { href: 'https://example.com/' }, innerWidth: 800, innerHeight: 600,
    URL, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  };
  return vm.runInNewContext(source, context);
}
module.exports = [
  { name: 'live default form button requires approval and binds approval to unchanged node', gate: 'C1', fn: async (assert) => {
    const clicks = { count: 0 };
    const button = makeElement('BUTTON', { label: 'Continue', inForm: true, clicks });
    const raw = runScript(forgeSnapshotScript(), button, { ids: new WeakMap(), nodes: new Map(), next: 1 });
    assert.strictEqual(raw.elements[0].is_submit, true);
    const witness = JSON.stringify({ forgeApproval: true, label: 'Continue', href: '', type: 'submit', isSubmit: true });
    assert.strictEqual(runScript(forgeActionScript(1, 'click', null), button, { nodes: new Map([[1, button]]) }).ok, false);
    assert.strictEqual(clicks.count, 0);
    button.innerText = 'Continue changed';
    assert.strictEqual(runScript(forgeActionScript(1, 'click', witness), button).ok, false);
    button.innerText = 'Continue';
    assert.strictEqual(runScript(forgeActionScript(1, 'click', witness), button).reason, 'approval_required_or_stale');
    assert.strictEqual(clicks.count, 0, 'a caller-created witness cannot activate the button');
    button.isConnected = false;
    assert.strictEqual(runScript(forgeActionScript(1, 'click', witness), button).reason, 'detached');
    button.isConnected = true;
    button.type = 'button';
    button.closest = () => null;
    assert.strictEqual(runScript(forgeActionScript(1, 'click', null), button).reason, 'approval_required_or_stale');
    button.type = 'submit';
    assert.strictEqual(runScript(forgeActionScript(1, 'click', null), button).reason, 'approval_required_or_stale');
    assert.strictEqual(clicks.count, 0);
  } },
  { name: 'live link destination refuses private URL and requires approval for public navigation', gate: 'C1', fn: async (assert) => {
    const clicks = { count: 0 };
    const link = makeElement('A', { label: 'Next', attributes: { href: 'http://127.0.0.1/private' }, clicks });
    assert.strictEqual(runScript(forgeActionScript(1, 'click', null), link).reason, 'unsafe_destination');
    link.getAttribute = (key) => key === 'href' ? '/next' : null;
    assert.strictEqual(runScript(forgeActionScript(1, 'click', null), link).reason, 'approval_required_or_stale');
    assert.strictEqual(clicks.count, 0);
  } },
  { name: 'page script never serializes password or card values', gate: 'C1', fn: async (assert) => {
    const clicks = { count: 0 };
    for (const [type, name, marker] of [['password', 'login', 'fixture-password'], ['text', 'card_number', 'fixture-card'], ['text', 'otp', 'fixture-otp']]) {
      const input = makeElement('INPUT', { type, name, value: marker, label: 'Field', clicks });
      const raw = runScript(forgeSnapshotScript(), input, { ids: new WeakMap(), nodes: new Map(), next: 1 });
      assert.strictEqual(raw.elements[0].current_value, '');
      assert.ok(!JSON.stringify(raw).includes(marker));
    }
  } },
];
