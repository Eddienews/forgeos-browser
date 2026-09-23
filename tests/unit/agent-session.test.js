'use strict';
const { createAgentSession } = require('../../src/engine/agent-network-proxy');
module.exports = [
  { name: 'proxy starts and is configured before any agent view can load', gate: 'C1', fn: async a => {
    const calls = [];
    const ses = { setProxy: async c => { calls.push('proxy'); a.ok(c.proxyBypassRules.includes('<-loopback>')); }, resolveProxy: async () => 'PROXY 127.0.0.1:8123' };
    const lease = await createAgentSession({ session: { fromPartition: p => { calls.push('session'); a.ok(!p.startsWith('persist:')); return ses; } },
      proxyFactory: () => ({ start: async () => { calls.push('start'); return { port: 8123, proxyConfig: { mode: 'fixed_servers', proxyRules: '127.0.0.1:8123', proxyBypassRules: '<-loopback>' } }; }, stop: async () => calls.push('stop'), isListening: () => true }),
      probe: async () => true });
    await lease.assertReady();
    a.deepStrictEqual(calls, ['start', 'session', 'proxy']);
    await lease.stop();
  } },
  { name: 'proxy setup failure cannot grant a session', gate: 'C1', fn: async a => {
    let stopped = 0;
    await a.rejects(createAgentSession({ session: { fromPartition: () => ({ setProxy: async () => { throw Error('failed'); } }) },
      proxyFactory: () => ({ start: async () => ({ port: 8123, proxyConfig: {} }), stop: async () => stopped++ }) }));
    a.strictEqual(stopped, 1);
  } },
  { name: 'DIRECT bypass in resolved session refuses lease and stops proxy', gate: 'C1', fn: async a => {
    let stopped = 0;
    await a.rejects(createAgentSession({ session: { fromPartition: () => ({
      setProxy: async () => {}, resolveProxy: async () => 'DIRECT', isPersistent: () => false,
    }) }, proxyFactory: () => ({ start: async () => ({ port: 8123, proxyConfig: {
      mode: 'fixed_servers', proxyRules: '127.0.0.1:8123', proxyBypassRules: '<-loopback>',
    } }), stop: async () => stopped++, isListening: () => true }), probe: async () => true }), /bypass/);
    a.strictEqual(stopped, 1);
  } },
];
