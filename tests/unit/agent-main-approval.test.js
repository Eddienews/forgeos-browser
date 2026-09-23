'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { forgeActionScript, forgeScrollScript } = require('../../src/page-actions');

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
  const page = { window: { __forgeAgent: { nodes: new Map([[1, button]]) } },
    document: { elementFromPoint: () => button, querySelectorAll: () => [], getElementById: () => null }, URL, Map,
    location: { href: 'https://example.com/page', origin: 'https://example.com', pathname: '/page', search: '' },
    innerWidth: 800, innerHeight: 600 };
  const scripts = [];
  const wc = { getURL: () => page.location.href, isDestroyed: () => false,
    executeJavaScript: async source => { scripts.push(source); return vm.runInNewContext(source, page); } };
  const tab = { wc };
  let active = tab;
  const dialogs = [];
  const logs = [];
  const context = { activeTab: () => active, forgeActionScript, forgeScrollScript, require,
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
  return { ...context, button, form, page, wc, tab, dialogs, logs, scripts, switchTab: () => { active = { wc }; }, clicks: () => clicks };
}
const action = () => ({ kind: 'click', targetIndex: 1, value: null, label: 'Continue' });
const info = act => ({ action: act, policy: { why: 'control with side effects' } });

module.exports = [
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
