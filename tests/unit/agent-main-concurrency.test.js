'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`missing main lifecycle section: ${start}`);
  return source.slice(a, b);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function turn() { await Promise.resolve(); await Promise.resolve(); }
function harness() {
  const events = [];
  const human = { id: 1, agentOwned: false, url: 'https://human.example/', wc: {
    getURL: () => 'https://human.example/', isDestroyed: () => false, loadURL: () => { events.push('HUMAN LOAD'); },
  } };
  const tabs = new Map([[1, human]]), sessions = new Map();
  const leases = [], pendingLeases = [];
  let activeTabId = 1, agentLease = null, agentTabId = null, seq = 1;
  let quit;
  const context = {
    tabs, sessions, session: {}, chromeWin: { contentView: { removeChildView: () => {} } },
    activeTab: () => tabs.get(activeTabId) || null, clearSessionData: async () => {},
    log: { log: () => {} }, persistOpenTabs: () => {}, sendState: () => {},
    get activeTabId() { return activeTabId; }, set activeTabId(v) { activeTabId = v; },
    get agentLease() { return agentLease; }, set agentLease(v) { agentLease = v; },
    get agentTabId() { return agentTabId; }, set agentTabId(v) { agentTabId = v; },
    createAgentSession: async () => {
      const pending = deferred(); pendingLeases.push(pending);
      return pending.promise;
    },
    createTab: (_url, opts) => {
      const id = ++seq, partition = opts.agentLease.partition;
      const tab = { id, agentOwned: true, partition, url: 'about:blank', view: {}, adapter: { session: {} },
        wc: { isDestroyed: () => !!tab.closed, close: () => { tab.closed = true; events.push(`close:${id}`); },
          getURL: () => tab.url, loadURL: async url => { tab.url = url; events.push(`load:${id}:${url}`); } } };
      tabs.set(id, tab); sessions.set(partition, {}); events.push(`tab:${id}`); return tab;
    },
    switchTab: id => { activeTabId = id; events.push(`switch:${id}`); },
    agentApi: null,
    app: { on: (_event, callback) => { quit = callback; } },
  };
  const prelude = section('async function closeTab(', 'async function changePrivacyMode');
  const navigation = section('const AGENT_RECOVERY = ', 'async function approveAgentNavigation');
  const quitSource = section("app.on('before-quit', () => {", '\n});');
  vm.runInNewContext(prelude + navigation + quitSource + '\n});\nthis.navigate = navigateAgent; this.closeTab = closeTab;', context);
  return {
    context, events, tabs, leases, pendingLeases,
    makeLease(ready = async () => {}) {
      const partition = `agent-fixture-${leases.length + 1}`;
      const lease = { partition, assertReady: ready, stop: async () => { events.push(`stop:${partition}`); } };
      leases.push(lease); return lease;
    },
    active: () => tabs.get(activeTabId), activate: id => { activeTabId = id; },
    quit: () => quit(),
  };
}
module.exports = [
  { name: 'overlapping first navigations allocate at most one lease and tab', gate: 'C1', fn: async a => {
    const h = harness();
    const first = h.context.navigate('https://agent.example/one');
    const second = h.context.navigate('https://agent.example/two');
    await turn();
    a.strictEqual(h.pendingLeases.length, 1, 'second navigation must not start another proxy');
    h.pendingLeases[0].resolve(h.makeLease());
    await first;
    await a.rejects(second, /agent navigation|in progress|stale/i);
    a.strictEqual(h.tabs.size, 2);
    a.strictEqual(h.events.filter(e => e.startsWith('load:')).length, 1);
    a.ok(!h.events.includes('HUMAN LOAD'));
  } },
  { name: 'active-tab switch during existing lease readiness refuses load', gate: 'C1', fn: async a => {
    const h = harness();
    const init = h.context.navigate('https://agent.example/one');
    await turn(); h.pendingLeases[0].resolve(h.makeLease()); await init;
    const ready = deferred(); h.leases[0].assertReady = () => ready.promise;
    const next = h.context.navigate('https://agent.example/two');
    h.activate(1); ready.resolve();
    await a.rejects(next, /Open an agent tab|stale/i);
    a.strictEqual(h.events.filter(e => e.startsWith('load:')).length, 1);
    a.ok(!h.events.includes('HUMAN LOAD'));
  } },
  { name: 'close during initial readiness stops proxy, closes tab and refuses late load', gate: 'C1', fn: async a => {
    const h = harness(), ready = deferred();
    const nav = h.context.navigate('https://agent.example/one');
    await turn(); h.pendingLeases[0].resolve(h.makeLease(() => ready.promise));
    await turn();
    const id = h.context.agentTabId;
    a.ok(id, 'agent tab must exist');
    const close = h.context.closeTab(id);
    ready.resolve();
    await close;
    await a.rejects(nav, /Open an agent tab|stale/i);
    a.strictEqual(h.tabs.size, 1);
    a.ok(h.events.includes(`stop:agent-fixture-1`));
    a.ok(h.events.includes(`close:${id}`));
    a.ok(!h.events.some(e => e.startsWith('load:')));
    a.ok(!h.events.includes('HUMAN LOAD'));
  } },
  { name: 'tab switch while lease creation is deferred stops orphan without opening agent tab', gate: 'C1', fn: async a => {
    const h = harness();
    const nav = h.context.navigate('https://agent.example/one');
    await turn();
    const secondHuman = { id: 90, agentOwned: false, wc: { isDestroyed: () => false } };
    h.tabs.set(90, secondHuman);
    h.activate(90);
    h.pendingLeases[0].resolve(h.makeLease());
    await a.rejects(nav, /Open an agent tab/);
    a.strictEqual(h.tabs.size, 2);
    a.ok(h.events.includes('stop:agent-fixture-1'));
    a.ok(!h.events.some(e => e.startsWith('load:') || e === 'HUMAN LOAD'));
  } },
  { name: 'quit during in-flight readiness closes agent tab and refuses late load', gate: 'C1', fn: async a => {
    const h = harness(), ready = deferred();
    const nav = h.context.navigate('https://agent.example/one');
    await turn(); h.pendingLeases[0].resolve(h.makeLease(() => ready.promise));
    await turn();
    const id = h.context.agentTabId;
    a.ok(id);
    h.quit(); ready.resolve();
    await a.rejects(nav, /Open an agent tab/);
    a.strictEqual(h.tabs.size, 1);
    a.ok(h.events.includes(`stop:agent-fixture-1`));
    a.ok(h.events.includes(`close:${id}`));
    a.ok(!h.events.some(e => e.startsWith('load:') || e === 'HUMAN LOAD'));
  } },
  { name: 'quit during deferred lease creation disposes late orphan without creating tab', gate: 'C1', fn: async a => {
    const h = harness();
    const nav = h.context.navigate('https://agent.example/one');
    await turn();
    h.quit();
    h.pendingLeases[0].resolve(h.makeLease());
    await a.rejects(nav, /quit|stale|Open an agent tab/i);
    a.strictEqual(h.tabs.size, 1);
    a.ok(h.events.includes('stop:agent-fixture-1'));
    a.ok(!h.events.includes('HUMAN LOAD'));
  } },
];
