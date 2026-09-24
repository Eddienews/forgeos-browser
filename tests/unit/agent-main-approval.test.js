'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { forgeActionScript, forgeScrollScript, forgeEffectProofSource, forgeProofDigestSource } = require('../../src/page-actions');
const { snapshotSafetyScript } = require('../../src/engine/sensitive-fields');
const { compareAgentPreview, hashEffectProof } = require('../../src/engine/action-policy');

// Exercise the actual main-process functions with a mocked Electron webContents
// and a live VM page. No real browser or credentials are involved.
function harness(onDialog = () => {}) {
  let clicks = 0;
  const form = { action: 'https://example.com/submit', method: 'post' };
  const button = {
    tagName: 'BUTTON', type: 'submit', value: '', innerText: 'Continue', disabled: false, isConnected: true, form,
    checkVisibility: () => true, getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 20 }),
    contains: other => other === button, closest: selector => selector === 'form' ? form : null,
    getAttribute: () => null, click: () => { clicks += 1; },
  };
  let currentElement = button;
  const page = { window: { __forgeAgent: { nodes: new Map([[1, button]]) } },
    document: { elementFromPoint: () => currentElement, querySelectorAll: () => [], getElementById: () => null }, URL, Map,
    location: { href: 'https://example.com/page', origin: 'https://example.com', pathname: '/page', search: '' },
    innerWidth: 800, innerHeight: 600, TextEncoder,
    Event: class Event { constructor(type) { this.type = type; } } };
  const scripts = [];
  const wc = { getURL: () => page.location.href, isDestroyed: () => false,
    executeJavaScript: async source => { scripts.push(source); return vm.runInNewContext(source, page); } };
  const tab = { wc };
  let active = tab;
  const dialogs = [];
  const logs = [];
  const context = { activeTab: () => active, forgeActionScript, forgeScrollScript, compareAgentPreview, hashEffectProof, require,
    requireAgentTab: async () => { if (active !== tab) throw Error('agent tab switched'); return tab; },
    chromeWin: { isDestroyed: () => false }, log: { log: (...entry) => { logs.push(entry); } },
    dialog: { showMessageBox: async (_win, options) => {
      dialogs.push(options);
      onDialog({ button, form, page, tab });
      return { response: 1 };
    } } };
  const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const begin = source.indexOf('const agentClickApprovals = new WeakMap();');
  const end = source.indexOf('let smokeDone = false;', begin);
  if (begin < 0 || end < 0) throw new Error('main-process action functions not found');
  vm.runInNewContext(source.slice(begin, end) + '\nthis.approve = approveAgentAction; this.act = executeAgentAction;', context);
  return { ...context, button, form, page, wc, tab, dialogs, logs, scripts,
    installTarget: element => { currentElement = element; page.window.__forgeAgent.nodes.set(1, element); },
    switchTab: () => { active = { wc }; }, clicks: () => clicks };
}
const action = () => ({ kind: 'click', targetIndex: 1, value: null, label: 'Continue' });
const info = act => ({ action: act, policy: { why: 'control with side effects' } });
function bindObserved(h, target) {
  const proof = vm.runInNewContext(`(() => { ${snapshotSafetyScript()} ${forgeEffectProofSource()}
    return forgeEffectProof(window.__forgeAgent.nodes.get(1)); })()`, h.page);
  target.fingerprint = 'test-observation';
  h.tab.agentOwned = true;
  h.tab.lastAgentObservation = {
    url: 'https://example.com/page',
    effectProofHashes: new Map([[1, hashEffectProof(proof)]]),
    snapshot: { url: 'https://example.com/page', fingerprint: target.fingerprint, elements: [{
      index: 1, kind: 'click', label: 'Continue', is_submit: true,
      form_action: 'https://example.com/submit', form_method: 'post', href: null,
    }] },
  };
}

module.exports = [
  { name: 'agent action preview binds observed target and shows effect before allow once', gate: 'C1', fn: async a => {
    const h = harness(); const target = action(); bindObserved(h, target);
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(h.dialogs[0].message.includes('Action preview'));
    a.ok(h.dialogs[0].detail.includes('browser-held target/effect witness matched'));
    a.ok(h.dialogs[0].detail.includes('Destination: https://example.com/submit'));
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(h.clicks(), 1);
  } },
  { name: 'changed target since observation cancels preview without approval', gate: 'C1', fn: async a => {
    const h = harness(); const target = action(); bindObserved(h, target);
    h.button.innerText = 'Delete account';
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual(Array.from(h.dialogs[0].buttons).join(','), 'Close');
    a.ok(h.dialogs[0].detail.includes('target/effect proof'));
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'changed destination since observation cancels preview before approval', gate: 'C1', fn: async a => {
    const h = harness(); const target = action(); bindObserved(h, target);
    h.form.action = 'https://other.test/collect';
    a.strictEqual(await h.approve(info(target)), false);
    a.ok(h.dialogs[0].detail.includes('destination'));
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'redacted query change before preview must not inherit approval', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    h.form.action = 'https://example.com/submit?recipient=alice';
    bindObserved(h, target);
    h.tab.lastAgentObservation.snapshot.elements[0].form_action =
      'https://example.com/submit?recipient=%3CREDACTED%3E';
    h.form.action = 'https://example.com/submit?recipient=attacker';
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'unchanged labeled fill and select do not fail due to display label shape', gate: 'C1', fn: a => {
    const fill = { kind: 'fill', label: 'Search', input_type: 'search', form_method: null };
    const select = { kind: 'select', label: 'Color -> Blue', input_type: 'select-one', form_method: null };
    a.deepStrictEqual(compareAgentPreview(fill, {
      descriptor: { type: 'search', formMethod: '' }, display: { label: '', destination: '' },
    }, 'https://example.com', 'fill'), []);
    a.deepStrictEqual(compareAgentPreview(select, {
      descriptor: { type: 'select-one', formMethod: '' }, display: { label: 'Blue Red', destination: '' },
    }, 'https://example.com', 'select'), []);
  } },
  { name: 'agent-owned labeled fill previews and executes the observed field', gate: 'C1', fn: async a => {
    const h = harness(); let events = 0;
    const field = { tagName: 'INPUT', type: 'search', value: '', name: 'search', id: 'query',
      labels: [{ textContent: 'Search' }], disabled: false, readOnly: false, isConnected: true,
      checkVisibility: () => true, getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
      contains: other => other === field, closest: () => null, getAttribute: () => null,
      dispatchEvent: () => { events++; } };
    h.installTarget(field);
    const target = { kind: 'fill', targetIndex: 1, value: 'fixture search', label: 'Search' };
    bindObserved(h, target);
    Object.assign(h.tab.lastAgentObservation.snapshot.elements[0], {
      kind: 'fill', label: 'Search', is_submit: false, input_type: 'search', form_action: null, form_method: null,
    });
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(h.dialogs[0].detail.includes('Element: [1] Search'));
    a.ok(!h.scripts[0].includes('fixture search'), 'proposed value reached untrusted page before approval');
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(field.value, 'fixture search');
    a.strictEqual(events, 2);
  } },
  { name: 'agent-owned select previews observed option then selects only that option', gate: 'C1', fn: async a => {
    const h = harness(); let events = 0;
    const field = { tagName: 'SELECT', type: 'select-one', value: 'red', innerText: 'Red Blue',
      name: 'color', labels: [{ textContent: 'Color' }],
      options: [{ value: 'red', text: 'Red', label: 'Red', disabled: false },
        { value: 'blue', text: 'Blue', label: 'Blue', disabled: false }],
      disabled: false, readOnly: false, isConnected: true,
      checkVisibility: () => true, getClientRects: () => [{ x: 10, y: 10, width: 80, height: 20 }],
      contains: other => other === field, closest: () => null, getAttribute: () => null,
      dispatchEvent: () => { events++; } };
    h.installTarget(field);
    const target = { kind: 'select', targetIndex: 1, optionIndex: 1, value: 'blue', label: 'Color -> Blue' };
    bindObserved(h, target);
    Object.assign(h.tab.lastAgentObservation.snapshot.elements[0], {
      kind: 'select', label: 'Color -> Blue', option_value: 'blue', option_index: 1,
      is_submit: false, input_type: 'select-one', form_action: null, form_method: null,
    });
    h.tab.lastAgentObservation.snapshot.elements.unshift({ index: 1, kind: 'select',
      label: 'Color -> Red', option_value: 'red', option_index: 0 });
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(h.dialogs[0].detail.includes('Element: [1] Color -> Blue'));
    a.ok(!h.scripts[0].includes('"blue"'), 'proposed option must not reach page before native approval');
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(field.value, 'blue');
    a.strictEqual(events, 2);
    a.strictEqual(await h.approve(info(target)), true);
    target.optionIndex = 0;
    a.strictEqual((await h.act(target)).ok, false, 'approval cannot be transferred to another option');
    target.optionIndex = 1;
    a.strictEqual((await h.act(target)).ok, false, 'a refused approval is consumed');
    a.strictEqual(field.value, 'blue');
    a.strictEqual(events, 2);
  } },
  { name: 'stale fingerprint rejects agent proposal before preview', gate: 'C1', fn: async a => {
    const h = harness(); const target = action(); bindObserved(h, target);
    target.fingerprint = 'from-earlier-snapshot';
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual(h.dialogs.length, 0);
  } },
  { name: 'a new observation during the native dialog expires approval', gate: 'C1', fn: async a => {
    let h;
    h = harness(() => { h.tab.lastAgentObservation = { ...h.tab.lastAgentObservation }; });
    const target = action(); bindObserved(h, target);
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual((await h.act(target)).ok, false);
  } },
  { name: 'approval inspection does not inject goal, policy or proposed value into the untrusted page', gate: 'C1', fn: async a => {
    const h = harness();
    const marker = 'fixturePrivateIntentOnly73';
    const target = action();
    target.label = marker;
    const request = { action: target, policy: { why: marker }, goal: marker };
    a.strictEqual(await h.approve(request), true);
    a.ok(h.scripts.length >= 2);
    a.ok(!h.scripts[0].includes(marker), 'inspection script exposed main-process intent to page');
    a.ok(!JSON.stringify(h.dialogs).includes(marker), 'dialog displayed unsanitized intent');
    a.ok(!JSON.stringify(h.logs).includes(marker), 'audit logged unsanitized intent');
    const fill = { ...target, kind: 'fill', value: marker };
    await h.approve({ action: fill, policy: { why: marker }, goal: marker });
    a.ok(!h.scripts[h.scripts.length - 1].includes(marker), 'pre-approval fill value reached page');
  } },
  { name: 'native dialog and decision log redact duplicated synthetic sensitive field value without weakening raw proof', gate: 'C1', fn: async a => {
    const h = harness();
    const marker = 'fixtureSensitiveClick92';
    const sensitive = { tagName: 'INPUT', type: 'password', name: 'password', value: marker,
      getAttribute: key => key === 'type' ? 'password' : key === 'name' ? 'password' : null,
      closest: () => null, labels: [] };
    h.page.document.querySelectorAll = selector => selector === 'input, select, textarea' ? [sensitive] : [];
    h.page.document.getElementById = () => null;
    h.button.value = marker;
    h.button.innerText = '';
    h.page.location.href = `https://example.com/page/${marker}?item=${marker}`;
    h.page.location.pathname = `/page/${marker}`;
    h.form.action = `https://example.com/submit/${marker}?item=${marker}`;
    const target = action();
    target.label = marker;
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(!JSON.stringify(h.dialogs).includes(marker), 'dialog must not echo the sensitive value');
    a.ok(!JSON.stringify(h.logs).includes(marker), 'decision log must not echo the sensitive value');
    a.ok(h.dialogs[0].detail.includes('<REDACTED>'));
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual(h.clicks(), 1);
    h.page.location.href = `https://example.com/page/other?item=${marker}`;
    a.strictEqual((await h.act(target)).ok, false);
  } },
  { name: 'distinct raw destinations remain unequal even when both render as redacted', gate: 'C1', fn: async a => {
    const first = 'fixtureProofAlpha94', second = 'fixtureProofBravo95';
    let sensitive;
    const h = harness(({ form }) => { sensitive.value = second; form.action = `https://example.com/submit/${second}`; });
    sensitive = { tagName: 'INPUT', type: 'password', value: first,
      getAttribute: key => key === 'type' ? 'password' : null, closest: () => null, labels: [] };
    h.page.document.querySelectorAll = selector => selector === 'input, select, textarea' ? [sensitive] : [];
    h.form.action = `https://example.com/submit/${first}`;
    const target = action();
    a.strictEqual(await h.approve(info(target)), false);
    a.ok(h.dialogs[0].detail.includes('Destination: https://example.com/submit/<REDACTED>'));
    a.ok(!JSON.stringify(h.dialogs).includes(first));
    a.ok(!JSON.stringify(h.dialogs).includes(second));
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'native display scrubs duplicated sensitive associated label even when field is empty', gate: 'C1', fn: async a => {
    const h = harness();
    const marker = 'fixtureLabelDuplicate96';
    const sensitive = { tagName: 'INPUT', type: 'text', name: 'ordinary', value: '',
      labels: [{ textContent: `Password ${marker}` }], getAttribute: () => null, closest: () => null };
    h.page.document.querySelectorAll = selector => selector === 'input, select, textarea' ? [sensitive] : [];
    h.button.innerText = marker;
    const target = action(); target.label = marker;
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(!JSON.stringify(h.dialogs).includes(marker));
    a.ok(!JSON.stringify(h.logs).includes(marker));
    a.strictEqual((await h.act(target)).ok, true);
  } },
  { name: 'native dialog displays live form effect and approval activates once', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    a.ok(h.dialogs[0].detail.includes('Destination: https://example.com/submit'));
    a.ok(h.dialogs[0].detail.includes('Form method: post'));
    a.ok(h.dialogs[0].detail.includes('JavaScript event handlers may have additional unknown side effects'));
    a.strictEqual((await h.act(target)).ok, true);
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 1);
  } },
  { name: 'native approval refuses destination changed during dialog', gate: 'C1', fn: async a => {
    const h = harness(({ form }) => { form.action = 'https://other.test/receive'; }); const target = action();
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'native approval refuses destination changed after dialog', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    h.form.action = 'https://other.test/receive';
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'final atomic click refuses private effect proof changed after dialog', gate: 'C1', fn: async a => {
    const h = harness(); const target = action(); bindObserved(h, target);
    h.button.textContent = 'original content';
    // Bind the actual text at observation, then change only a field excluded
    // from the shorter action descriptor after approval.
    const original = vm.runInNewContext(`(() => { ${snapshotSafetyScript()} ${forgeEffectProofSource()}
      return forgeEffectProof(window.__forgeAgent.nodes.get(1)); })()`, h.page);
    h.tab.lastAgentObservation.effectProofHashes.set(1, hashEffectProof(original));
    a.strictEqual(await h.approve(info(target)), true);
    h.button.textContent = 'changed nested content';
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'private effect proof refuses an oversized page-controlled text before IPC', gate: 'C1', fn: a => {
    const h = harness(); h.button.textContent = 'x'.repeat(150000);
    const proof = vm.runInNewContext(`(() => { ${snapshotSafetyScript()} ${forgeEffectProofSource()}
      return forgeEffectProof(window.__forgeAgent.nodes.get(1)); })()`, h.page);
    a.strictEqual(proof, null);
  } },
  { name: 'synchronous page digest matches trusted SHA-256 for Unicode effects', gate: 'C1', fn: a => {
    for (const proof of [{ label: 'Pagar á€', href: '/?id=alice' },
      { options: [['東', false, '東京'], ['西', false, '大阪']], value: null }]) {
      const digest = vm.runInNewContext(`(() => { ${forgeProofDigestSource()}
        return forgeProofDigest(${JSON.stringify(proof)}); })()`, { TextEncoder });
      a.strictEqual(digest, hashEffectProof(proof));
    }
  } },
  { name: 'native proof refuses active-tab swap even at the same URL', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual(await h.approve(info(target)), true);
    h.switchTab();
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'native approval refuses target index changed during dialog', gate: 'C1', fn: async a => {
    const target = action();
    const h = harness(() => { target.targetIndex = 2; });
    a.strictEqual(await h.approve(info(target)), false);
    a.strictEqual(h.clicks(), 0);
  } },
  { name: 'native approval binds tab and node identity, ignores caller JSON witness', gate: 'C1', fn: async a => {
    const h = harness(); const target = action();
    a.strictEqual((await h.act({ ...target, value: JSON.stringify({ forgeApproval: true }) })).ok, false);
    a.strictEqual(await h.approve(info(target)), true);
    h.page.window.__forgeAgent.nodes.set(1, { ...h.button, contains: x => x === h.button });
    a.strictEqual((await h.act(target)).ok, false);
    a.strictEqual(h.clicks(), 0);
  } },
];
