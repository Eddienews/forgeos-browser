/* agent-approval.test.js — human-approval flow for agent navigations.
 * Starts the real Agent API on an ephemeral port and drives the confirmation
 * path: request → pending → human approves (navigates) / denies (no-op) /
 * unknown id (no-op). This is the "act requires approval" rule, tested. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startAgentApi } = require('../../src/ext/agent-api');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-approval-test-'));

function req(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Spin up the API on a free port; returns { port, token, navigated, api, close } */
async function boot() {
  const navigated = [];
  // Port 0 lets the OS pick a free port; read the real one back from server.
  const api = await startAgentApi({
    port: 0,
    baseDir: tmp,
    log: null,
    getSnapshot: () => ({ mode: 'standard', activeTabId: 1, tabs: [], session: {} }),
    readPage: async () => ({ url: 'about:blank', text: '', untrusted: true }),
    navigate: async (url) => { navigated.push(url); },
  });
  const port = api.server.address().port;
  return { port, token: api.bootstrapToken, navigated, api };
}

module.exports = [
  {
    name: 'agent navigation requires approval before it runs',
    gate: 'A1',
    fn: async () => {
      const { port, token, navigated, api } = await boot();
      try {
        const r = await req(port, 'POST', '/navigate', token, { url: 'https://example.com' });
        if (r.body.status !== 'pending_confirmation') {
          throw new Error(`expected pending_confirmation, got ${JSON.stringify(r.body)}`);
        }
        if (!r.body.confirm_id) throw new Error('no confirm_id issued');
        if (navigated.length !== 0) throw new Error('agent navigated WITHOUT approval');
        // Human approves.
        const ok = api.resolveConfirm(r.body.confirm_id, true);
        if (ok !== true) throw new Error('resolveConfirm(approve) returned false');
        if (navigated.length !== 1 || navigated[0] !== 'https://example.com') {
          throw new Error(`approve did not navigate: ${JSON.stringify(navigated)}`);
        }
      } finally { api.server.close(); }
    },
  },
  {
    name: 'denied approval never navigates',
    gate: 'A1',
    fn: async () => {
      const { port, token, navigated, api } = await boot();
      try {
        const r = await req(port, 'POST', '/navigate', token, { url: 'https://evil.example' });
        const ok = api.resolveConfirm(r.body.confirm_id, false);
        if (ok !== false) throw new Error('deny should return false');
        if (navigated.length !== 0) throw new Error('denied navigation still ran');
      } finally { api.server.close(); }
    },
  },
  {
    name: 'unknown or reused confirm_id is rejected',
    gate: 'A1',
    fn: async () => {
      const { port, token, navigated, api } = await boot();
      try {
        const r = await req(port, 'POST', '/navigate', token, { url: 'https://once.example' });
        if (api.resolveConfirm('not-a-real-id', true) !== false) throw new Error('unknown id accepted');
        api.resolveConfirm(r.body.confirm_id, true);
        // Replaying the same id must not navigate again (single-use).
        if (api.resolveConfirm(r.body.confirm_id, true) !== false) throw new Error('confirm_id is replayable');
        if (navigated.length !== 1) throw new Error(`expected 1 navigation, got ${navigated.length}`);
      } finally { api.server.close(); }
    },
  },
  {
    name: 'read-scope token cannot navigate (scope enforced)',
    gate: 'A1',
    fn: async () => {
      const { port, token, navigated, api } = await boot();
      try {
        const readToken = api.issueToken('read');
        const r = await req(port, 'POST', '/navigate', readToken, { url: 'https://nope.example' });
        if (r.status !== 403) throw new Error(`read token got ${r.status}, expected 403`);
        if (navigated.length !== 0) throw new Error('read-scope token navigated');
        // sanity: full token still works for the same call shape
        const ok = await req(port, 'POST', '/navigate', token, { url: 'https://ok.example' });
        if (ok.body.status !== 'pending_confirmation') throw new Error('full token failed');
      } finally { api.server.close(); }
    },
  },
];
