'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { captureTabReloadPlan } = require('../../src/engine/storage-manager');
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const begin = source.indexOf('const AGENT_RECOVERY = ');
const end = source.indexOf('async function approveAgentNavigation', begin);
function harness() {
  const events = [];
  const human = { id: 1, agentOwned: false, wc: { isDestroyed: () => false, getURL: () => 'https://example.com/human' } };
  const tabs = new Map([[1, human]]);
  let activeTabId = 1, agentLease = null, agentTabId = null, proxyDown = false, serial = 1;
  const context = {
    tabs, session: {}, activeTab: () => tabs.get(activeTabId),
    get activeTabId() { return activeTabId; }, set activeTabId(x) { activeTabId = x; },
    get agentLease() { return agentLease; }, set agentLease(x) { agentLease = x; },
    get agentTabId() { return agentTabId; }, set agentTabId(x) { agentTabId = x; },
    createAgentSession: async () => {
      events.push('proxy-ready');
      const part = 'forge-agent-' + ++serial;
      return { partition: part, assertReady: async () => { if (proxyDown) throw Error('proxy down'); }, stop: async () => events.push('proxy-stopped') };
    },
    createTab: (url, opts) => {
      events.push('create-tab');
      const tab = { id: ++serial, agentOwned: !!opts.agentLease, partition: opts.agentLease.partition,
        wc: { isDestroyed: () => false, getURL: () => tab.url, loadURL: async dest => { tab.url = dest; events.push('load'); } }, url };
      tabs.set(tab.id, tab); return tab;
    },
    switchTab: id => { activeTabId = id; events.push('switch'); },
    closeTab: async id => {
      tabs.delete(id); if (agentTabId === id) { agentTabId = null; await agentLease.stop(); agentLease = null; }
      activeTabId = 1;
    },
  };
  vm.runInNewContext(source.slice(begin, end) + '\nthis.guard = requireAgentTab; this.navigate = navigateAgent;', context);
  return { context, events, human, tabs, setDown: b => { proxyDown = b; }, activate: id => { activeTabId = id; }, current: () => tabs.get(activeTabId) };
}
module.exports = [
  { name: 'first action from human tab refuses without creating an agent tab', gate: 'C1', fn: async a => {
    const h = harness();
    await a.rejects(h.context.guard(), /Open an agent tab/);
    a.deepStrictEqual(h.events, []);
    a.strictEqual(h.current(), h.human);
  } },
  { name: 'navigation initializes proxy before agent view, leaves human intact and blocks tab swap', gate: 'C1', fn: async a => {
    const h = harness();
    await h.context.navigate('https://example.com/agent');
    a.deepStrictEqual(h.events, ['proxy-ready', 'create-tab', 'switch', 'load']);
    a.strictEqual((await h.context.guard()).agentOwned, true);
    h.activate(1);
    await a.rejects(h.context.guard(), /Open an agent tab/);
    await a.rejects(h.context.navigate('https://example.com/another'), /Open an agent tab/);
    a.strictEqual(h.human.wc.getURL(), 'https://example.com/human');
  } },
  { name: 'down proxy fails action and approved navigation replaces lease instead of falling back', gate: 'C1', fn: async a => {
    const h = harness(); await h.context.navigate('https://example.com/agent');
    h.setDown(true);
    await a.rejects(h.context.guard(), /proxy down/);
    h.setDown(false);
    // Simulate a failed lease followed by a healthy replacement.
    let count = 0;
    h.context.agentLease.assertReady = async () => { if (count++ === 0) throw Error('proxy down'); };
    await h.context.navigate('https://example.com/fresh');
    a.ok(h.events.includes('proxy-stopped'));
    a.strictEqual((await h.context.guard()).url, 'https://example.com/fresh');
    a.strictEqual(h.human.wc.getURL(), 'https://example.com/human');
  } },
  { name: 'mode reload plan excludes agent tab even when active', gate: 'C1', fn: a => {
    const tabs = new Map([[1, { id: 1, url: 'https://example.com/human' }], [2, { id: 2, agentOwned: true, url: 'https://example.com/agent' }]]);
    const plan = captureTabReloadPlan(tabs, 2);
    a.strictEqual(plan.items.length, 1);
    a.strictEqual(plan.activeIndex, -1);
  } },
];
