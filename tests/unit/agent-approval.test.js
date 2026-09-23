/* agent-approval.test.js — human-approval flow for agent navigations.
 * Drives the real Agent API on an ephemeral port: request → pending →
 * human approves (navigate runs) / denies (403, nothing runs) / unknown id
 * (400) / replay (400) / wrong-scope token (403). This is the
 * "act requires approval" rule, tested end-to-end against the hardened API. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns');
const { startAgentApi } = require('../../src/ext/agent-api');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-approval-test-'));

function req(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/**
 * Boot the API on an ephemeral port with a scripted human decision.
 * @param {boolean} humanAllows the answer the human gives when asked to approve
 */
async function boot(humanAllows = true) {
  const navigated = [];
  const asked = [];
  const api = await startAgentApi({
    port: 0,
    baseDir: tmp,
    log: null,
    getSnapshot: () => ({ mode: 'standard', activeTabId: 1, tabs: [], session: {} }),
    readPage: async () => ({ url: 'about:blank', text: '', untrusted: true }),
    navigate: async (url) => { navigated.push(url); },
    approveNavigate: async (url) => { asked.push(url); return humanAllows; },
  });
  const port = api.server.address().port;
  return { port, token: api.bootstrapToken, navigated, asked, api, close: () => api.stop() };
}

module.exports = [
  {
    name: 'confirmation refuses hostname rebound to private IP after approval', gate: 'C1',
    fn: async (assert) => {
      const original = dns.promises.lookup;
      let calls = 0;
      dns.promises.lookup = async () => [{ address: ++calls === 1 ? '93.184.215.14' : '10.1.2.3', family: 4 }];
      let t;
      try {
        t = await boot(true);
        const pending = await req(t.port, 'POST', '/navigate', t.token, { url: 'https://rebind.example/path' });
        assert.strictEqual(pending.status, 200);
        const confirm = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: pending.body.confirm_id });
        assert.strictEqual(confirm.status, 403);
        assert.strictEqual(t.asked.length, 1);
        assert.strictEqual(t.navigated.length, 0);
        assert.strictEqual((await req(t.port, 'POST', '/navigate/confirm', t.token,
          { confirm_id: pending.body.confirm_id })).status, 400);
      } finally {
        if (t) await t.close();
        dns.promises.lookup = original;
      }
    },
  },
  {
    name: 'agent navigation stays pending, then runs once after human approval',
    gate: 'A1',
    fn: async () => {
      const t = await boot(true);
      try {
        const r = await req(t.port, 'POST', '/navigate', t.token, { url: 'https://example.com' });
        if (!r.body || r.body.status !== 'pending_confirmation') {
          throw new Error(`expected pending_confirmation, got ${JSON.stringify(r.body)}`);
        }
        if (!r.body.confirm_id) throw new Error('no confirm_id issued');
        if (t.navigated.length !== 0) throw new Error('navigated BEFORE human approval');

        const c = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: r.body.confirm_id });
        if (c.status !== 200) throw new Error(`confirm returned ${c.status}: ${JSON.stringify(c.body)}`);
        if (t.asked.length !== 1) throw new Error('the human was never asked');
        if (t.navigated.length !== 1 || t.navigated[0] !== 'https://example.com') {
          throw new Error(`approval did not navigate exactly once: ${JSON.stringify(t.navigated)}`);
        }
      } finally { await t.close(); }
    },
  },
  {
    name: 'human denial blocks the navigation',
    gate: 'A1',
    fn: async () => {
      const t = await boot(false);
      try {
        const r = await req(t.port, 'POST', '/navigate', t.token, { url: 'https://example.com/denied' });
        const c = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: r.body.confirm_id });
        if (c.status !== 403) throw new Error(`denial should be 403, got ${c.status}`);
        if (t.navigated.length !== 0) throw new Error('denied navigation still ran');
      } finally { await t.close(); }
    },
  },
  {
    name: 'unknown and replayed confirm_id are rejected (single-use)',
    gate: 'A1',
    fn: async () => {
      const t = await boot(true);
      try {
        const bad = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: 'deadbeefdeadbeefdeadbeef' });
        if (bad.status !== 400) throw new Error(`unknown id should be 400, got ${bad.status}`);

        const r = await req(t.port, 'POST', '/navigate', t.token, { url: 'https://example.com/once' });
        const first = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: r.body.confirm_id });
        if (first.status !== 200) throw new Error(`first confirm failed: ${first.status}`);
        const replay = await req(t.port, 'POST', '/navigate/confirm', t.token, { confirm_id: r.body.confirm_id });
        if (replay.status !== 400) throw new Error(`replay should be 400, got ${replay.status}`);
        if (t.navigated.length !== 1) throw new Error(`expected exactly 1 navigation, got ${t.navigated.length}`);
      } finally { await t.close(); }
    },
  },
  {
    name: 'read-scope token cannot navigate (scope enforced)',
    gate: 'A1',
    fn: async () => {
      const t = await boot(true);
      try {
        const readToken = t.api.issueToken('read');
        const r = await req(t.port, 'POST', '/navigate', readToken, { url: 'https://example.com/nope' });
        if (r.status !== 403) throw new Error(`read token got ${r.status}, expected 403`);
        if (t.navigated.length !== 0) throw new Error('read-scope token navigated');
      } finally { await t.close(); }
    },
  },
];
