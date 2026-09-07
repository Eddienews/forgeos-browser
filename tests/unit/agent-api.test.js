'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  MAX_BODY_BYTES, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
  isAllowedHostHeader, normalizedAuditMethod, normalizedAuditRoute,
  startAgentApi, writePrivateTokenFile,
} = require('../../src/ext/agent-api');

// Real loopback HTTP requests; no external service or browser navigation.
async function withApi(check, {
  pageView = {}, approveNavigation = async () => true, apiOptions = {},
} = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-api-test-'));
  const navigations = [];
  const approvalRequests = [];
  let time = 1000;
  let api;
  try {
    api = await startAgentApi({
      port: 0, baseDir,
      confirmationNow: () => time,
      getSnapshot: () => ({ tabs: [], session: {} }),
      readPage: async () => pageView,
      approveNavigate: async (url, context) => {
        approvalRequests.push({ url, context });
        return approveNavigation(url, context);
      },
      navigate: async (url) => { navigations.push(url); },
      tokenNow: () => time,
      rateNow: () => time,
      auditNow: () => time,
      ...apiOptions,
    });
    const request = (method, route, token, body, {
      raw = false, contentType = 'application/json', headers = {},
    } = {}) => new Promise((resolve, reject) => {
      const requestHeaders = { authorization: `Bearer ${token}`, ...headers };
      if (contentType !== null) requestHeaders['content-type'] = contentType;
      const req = http.request({
        host: '127.0.0.1', port: api.server.address().port,
        path: route, method, agent: false,
        headers: requestHeaders,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(3000, () => req.destroy(new Error('API test request timed out')));
      req.on('error', reject);
      req.end(body === undefined ? undefined : (raw ? body : JSON.stringify(body)));
    });
    const post = (route, token, body = {}) => request('POST', route, token, body);
    const get = (route, token) => request('GET', route, token);
    await check({ api, baseDir, request, get, post, navigations, approvalRequests, advance: (ms) => { time += ms; } });
  } finally {
    if (api) await api.stop();
    // Only this test's freshly allocated directory is removed.
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

const url = 'https://example.com/navigation-test';
module.exports = [
  {
    name: 'bootstrap token is atomically stored with private permissions',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, baseDir }) => {
      const contents = fs.readFileSync(api.tokenFile, 'utf8');
      assert.match(contents, /^scope=full\ntoken=fgb\./);
      assert.strictEqual(contents.includes(api.bootstrapToken), true);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(api.tokenFile).mode & 0o777, 0o600);
        assert.strictEqual(api.tokenProtection, '0600');
      }
      assert.deepStrictEqual(
        fs.readdirSync(baseDir).filter((name) => name.startsWith('forge-agent-token.')),
        [],
      );
    }),
  },
  {
    name: 'private token writer repairs permissions on an existing token file',
    gate: 'H',
    fn(assert) {
      if (process.platform === 'win32') return;
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-token-mode-test-'));
      const tokenFile = path.join(baseDir, 'forge-agent-token');
      try {
        fs.writeFileSync(tokenFile, 'old-token\n', { mode: 0o644 });
        fs.chmodSync(tokenFile, 0o644);
        assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o644);
        assert.strictEqual(writePrivateTokenFile(tokenFile, 'new-token\n'), '0600');
        assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'new-token\n');
        assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'agent API stays offline when secure token storage fails',
    gate: 'H',
    async fn(assert) {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-api-fail-test-'));
      try {
        await assert.rejects(startAgentApi({
          port: 0,
          baseDir: path.join(baseDir, 'missing-directory'),
          getSnapshot: () => ({}),
          readPage: async () => ({}),
          approveNavigate: async () => true,
          navigate: async () => {},
        }), /secure token storage failed/);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'clean shutdown removes only the token owned by that API instance',
    gate: 'H',
    fn: (assert) => withApi(async ({ api }) => {
      assert.strictEqual(fs.existsSync(api.tokenFile), true);
      const stopped = await api.stop();
      assert.strictEqual(stopped.tokenRemoved, true);
      assert.strictEqual(fs.existsSync(api.tokenFile), false);
      assert.deepStrictEqual(await api.stop(), stopped);
    }),
  },
  {
    name: 'shutdown preserves a token file replaced by another owner',
    gate: 'H',
    fn: (assert) => withApi(async ({ api }) => {
      const replacement = 'scope=full\ntoken=foreign-owner\n';
      writePrivateTokenFile(api.tokenFile, replacement);
      const stopped = await api.stop();
      assert.strictEqual(stopped.tokenRemoved, false);
      assert.strictEqual(fs.readFileSync(api.tokenFile, 'utf8'), replacement);
    }),
  },
  {
    name: 'a second in-process Agent API is rejected without creating credentials',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, get }) => {
      const otherBase = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-api-duplicate-test-'));
      try {
        await assert.rejects(startAgentApi({
          port: 0,
          baseDir: otherBase,
          getSnapshot: () => ({ tabs: [], session: {} }),
          readPage: async () => ({}),
          approveNavigate: async () => true,
          navigate: async () => {},
        }), /already running/);
        assert.strictEqual(fs.existsSync(path.join(otherBase, 'forge-agent-token')), false);
        assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
      } finally {
        fs.rmSync(otherBase, { recursive: true, force: true });
      }
    }),
  },
  {
    name: 'bind failure preserves existing credentials and releases lifecycle ownership',
    gate: 'H',
    async fn(assert) {
      const blocker = http.createServer((_req, res) => res.end('occupied'));
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-api-bind-test-'));
      const tokenFile = path.join(baseDir, 'forge-agent-token');
      const preserved = 'existing-instance-token\n';
      fs.writeFileSync(tokenFile, preserved, { mode: 0o600 });
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      let recovered;
      try {
        const common = {
          baseDir,
          getSnapshot: () => ({ tabs: [], session: {} }),
          readPage: async () => ({}),
          approveNavigate: async () => true,
          navigate: async () => {},
        };
        await assert.rejects(startAgentApi({
          ...common,
          port: blocker.address().port,
        }), /failed to bind.*EADDRINUSE/);
        assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), preserved);
        recovered = await startAgentApi({ ...common, port: 0 });
        assert.strictEqual(recovered.server.listening, true);
      } finally {
        if (recovered) await recovered.stop();
        await new Promise((resolve) => blocker.close(resolve));
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'full token rotation atomically replaces and revokes every credential',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, baseDir, get, post }) => {
      const oldBootstrap = api.bootstrapToken;
      const oldRead = api.issueToken('read');
      const oldNavigate = api.issueToken('navigate');
      const pending = await post('/navigate', oldNavigate, { url });
      assert.strictEqual(pending.status, 200);

      const rotated = await post('/token/rotate', oldBootstrap);
      assert.strictEqual(rotated.status, 200);
      assert.strictEqual(rotated.body.rotated, true);
      assert.strictEqual(rotated.body.scope, 'full');
      assert.match(rotated.body.token, /^fgb\./);
      assert.notStrictEqual(rotated.body.token, oldBootstrap);

      assert.strictEqual((await get('/status', oldBootstrap)).status, 401);
      assert.strictEqual((await get('/status', oldRead)).status, 401);
      assert.strictEqual((await post('/navigate/confirm', rotated.body.token, {
        confirm_id: pending.body.confirm_id,
      })).status, 400);
      assert.strictEqual((await get('/status', rotated.body.token)).status, 200);

      const stored = fs.readFileSync(path.join(baseDir, 'forge-agent-token'), 'utf8');
      assert.strictEqual(stored.includes(rotated.body.token), true);
      assert.strictEqual(stored.includes(oldBootstrap), false);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(api.tokenFile).mode & 0o777, 0o600);
      }
    }),
  },
  {
    name: 'rotation requires full scope and the exact POST route',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, get, post }) => {
      const reader = api.issueToken('read');
      const navigator = api.issueToken('navigate');
      assert.strictEqual((await post('/token/rotate', reader)).status, 403);
      assert.strictEqual((await post('/token/rotate', navigator)).status, 403);
      assert.strictEqual((await get('/token/rotate', api.bootstrapToken)).status, 404);
      assert.strictEqual((await get('/status', reader)).status, 200);
      assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
    }),
  },
  {
    name: 'failed token persistence rolls rotation back without revoking callers',
    gate: 'H',
    fn: (assert) => {
      let writes = 0;
      const tokenWriter = (...args) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated storage failure');
        return writePrivateTokenFile(...args);
      };
      return withApi(async ({ api, get, post }) => {
        const reader = api.issueToken('read');
        assert.strictEqual((await post('/token/rotate', api.bootstrapToken)).status, 503);
        assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
        assert.strictEqual((await get('/status', reader)).status, 200);
        assert.strictEqual(writes, 2);
      }, { apiOptions: { tokenWriter } });
    },
  },
  {
    name: 'tokens expire at the exact TTL boundary and discard pending approvals',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, get, post, advance }) => {
      const token = api.issueToken('full');
      const pending = await post('/navigate', token, { url });
      assert.strictEqual(pending.status, 200);
      assert.strictEqual((await get('/status', token)).status, 200);
      advance(60 * 60 * 1000);
      const expired = await get('/status', token);
      assert.strictEqual(expired.status, 401);
      assert.match(expired.body.error, /expired/);
      const replacement = api.issueToken('full');
      assert.strictEqual((await post('/navigate/confirm', replacement, {
        confirm_id: pending.body.confirm_id,
      })).status, 400);
    }),
  },
  {
    name: 'POST endpoints require JSON content type',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, request, get }) => {
      const refused = await request('POST', '/token/issue', api.bootstrapToken, '{"scope":"read"}', {
        raw: true,
        contentType: 'text/plain',
      });
      assert.strictEqual(refused.status, 415);
      assert.match(refused.body.error, /application\/json/);
      assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
    }),
  },
  {
    name: 'invalid or non-object JSON receives a client error without stopping the API',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, request, get }) => {
      const invalid = await request('POST', '/token/issue', api.bootstrapToken, '{"scope":', { raw: true });
      assert.strictEqual(invalid.status, 400);
      assert.match(invalid.body.error, /invalid JSON/);
      const primitive = await request('POST', '/token/issue', api.bootstrapToken, 'true', { raw: true });
      assert.strictEqual(primitive.status, 400);
      assert.match(primitive.body.error, /must be an object/);
      assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
    }),
  },
  {
    name: 'request body limit accepts the boundary and rejects one byte over it',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, request }) => {
      const prefix = '{"scope":"read","padding":"';
      const suffix = '"}';
      const padding = 'a'.repeat(MAX_BODY_BYTES - Buffer.byteLength(prefix + suffix));
      const atLimit = prefix + padding + suffix;
      assert.strictEqual(Buffer.byteLength(atLimit), MAX_BODY_BYTES);
      assert.strictEqual((await request('POST', '/token/issue', api.bootstrapToken, atLimit, {
        raw: true,
      })).status, 200);
      const overLimit = atLimit + ' ';
      const refused = await request('POST', '/token/issue', api.bootstrapToken, overLimit, { raw: true });
      assert.strictEqual(refused.status, 413);
      assert.match(refused.body.error, new RegExp(String(MAX_BODY_BYTES)));
    }),
  },
  {
    name: 'Agent API responses disable caching and MIME sniffing',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, get }) => {
      const response = await get('/status', api.bootstrapToken);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers['cache-control'], 'no-store');
      assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.headers['content-type'], /^application\/json/);
    }),
  },
  {
    name: 'every handled Agent API request emits one bounded redacted audit record',
    gate: 'H',
    fn(assert) {
      const entries = [];
      const log = { log: (tag, message, fields) => entries.push({ tag, message, fields }) };
      const secret = 'audit-secret-should-never-appear';
      assert.strictEqual(normalizedAuditMethod('delete'), 'OTHER');
      assert.strictEqual(normalizedAuditRoute(`/private/${secret}?token=${secret}`), '<unknown>');
      return withApi(async ({ api, request }) => {
        assert.strictEqual((await request(
          'GET', `/status?token=${secret}&password=${secret}`, api.bootstrapToken,
        )).status, 200);
        assert.strictEqual((await request(
          'GET', `/private/${secret}?password=${secret}`, api.bootstrapToken,
        )).status, 404);
        assert.strictEqual((await request(
          'POST', '/token/issue', api.bootstrapToken, `{"password":"${secret}"`, { raw: true },
        )).status, 400);

        const audits = entries.filter((entry) => entry.message === 'agent api request');
        assert.strictEqual(audits.length, 3);
        assert.deepStrictEqual(audits.map((entry) => entry.fields.route), [
          '/status', '<unknown>', '/token/issue',
        ]);
        assert.deepStrictEqual(audits.map((entry) => entry.fields.status), [200, 404, 400]);
        assert.deepStrictEqual(audits.map((entry) => entry.fields.decision), ['ALLOW', 'DENY', 'DENY']);
        for (const entry of audits) {
          assert.deepStrictEqual(Object.keys(entry.fields).sort(), [
            'decision', 'durationMs', 'method', 'requestId', 'route', 'scope', 'status',
          ]);
          assert.match(entry.fields.requestId, /^[0-9a-f]{12}$/);
          assert.strictEqual(entry.fields.scope, 'full');
          assert.strictEqual(Number.isSafeInteger(entry.fields.durationMs), true);
          assert.strictEqual(entry.fields.durationMs >= 0, true);
        }
        const serialized = JSON.stringify(audits);
        assert.strictEqual(serialized.includes(secret), false);
        assert.strictEqual(serialized.includes('password'), false);
        assert.strictEqual(serialized.includes('?'), false);
      }, { apiOptions: { log } });
    },
  },
  {
    name: 'an unavailable audit sink cannot change or duplicate an API response',
    gate: 'H',
    fn(assert) {
      let attempts = 0;
      const log = {
        log(_tag, message) {
          if (message !== 'agent api request') return;
          attempts += 1;
          throw new Error('simulated audit sink failure');
        },
      };
      return withApi(async ({ api, get }) => {
        const response = await get('/status', api.bootstrapToken);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(attempts, 1);
      }, { apiOptions: { log } });
    },
  },
  {
    name: 'Host validation accepts only complete loopback authorities',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, request }) => {
      for (const host of ['127.0.0.1', 'localhost:1', '[::1]:65535', 'LOCALHOST']) {
        assert.strictEqual(isAllowedHostHeader(host), true, host);
      }
      for (const host of [
        '', ' localhost', 'localhost.', 'localhost:0', 'localhost:65536',
        'localhost:80@evil.test', '127.0.0.1.evil.test', '::1',
      ]) {
        assert.strictEqual(isAllowedHostHeader(host), false, host);
      }

      const valid = await request('GET', '/status', api.bootstrapToken, undefined, {
        headers: { host: `localhost:${api.server.address().port}` },
      });
      assert.strictEqual(valid.status, 200);
      const rebound = await request('GET', '/status', api.bootstrapToken, undefined, {
        headers: { host: 'localhost:80@evil.test' },
      });
      assert.strictEqual(rebound.status, 403);
      assert.match(rebound.body.error, /host header/);
    }),
  },
  {
    name: 'all browser Origin headers are rejected while non-browser clients continue',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, request, get }) => {
      for (const origin of ['https://evil.test', 'null', 'file:///tmp/local.html', '']) {
        const response = await request('GET', '/status', api.bootstrapToken, undefined, {
          headers: { origin },
        });
        assert.strictEqual(response.status, 403, origin);
        assert.match(response.body.error, /browser-origin/);
      }
      assert.strictEqual((await get('/status', api.bootstrapToken)).status, 200);
    }),
  },
  {
    name: 'rate limiting is token-isolated and reports the real retry window',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, get, advance }) => {
      const token = api.issueToken('read');
      let response;
      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        response = await get('/status', token);
        assert.strictEqual(response.status, 200, `request ${i + 1}`);
      }
      assert.strictEqual(response.headers['x-ratelimit-limit'], String(RATE_LIMIT_MAX));
      assert.strictEqual(response.headers['x-ratelimit-remaining'], '0');

      const limited = await get('/status', token);
      assert.strictEqual(limited.status, 429);
      assert.strictEqual(limited.headers['retry-after'], String(RATE_LIMIT_WINDOW_MS / 1000));

      const independent = api.issueToken('read');
      assert.strictEqual((await get('/status', independent)).status, 200);

      advance(30001);
      const halfway = await get('/status', token);
      assert.strictEqual(halfway.status, 429);
      assert.strictEqual(halfway.headers['retry-after'], '30');

      advance(29999);
      const reset = await get('/status', token);
      assert.strictEqual(reset.status, 200);
      assert.strictEqual(reset.headers['x-ratelimit-remaining'], String(RATE_LIMIT_MAX - 1));
    }),
  },
  {
    name: 'page and links endpoints return the extracted sanitized agent view',
    gate: 'F',
    fn: (assert) => {
      const pageView = {
        url: 'https://example.com/article',
        title: 'Article',
        content: {
          paragraphs: ['Visible text'],
          links: [
            { text: 'Safe', href: 'https://example.com/safe' },
            { text: 'Secret', href: 'https://example.com/private', authorization: 'hidden' },
          ],
        },
        security: { untrusted: true },
        password: 'must-not-leak',
      };
      return withApi(async ({ api, get }) => {
        const token = api.issueToken('read');
        const page = await get('/page', token);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.body.url, pageView.url);
        assert.deepStrictEqual(page.body.content.paragraphs, ['Visible text']);
        assert.strictEqual(Object.hasOwn(page.body, 'password'), false);

        const links = await get('/links', token);
        assert.strictEqual(links.status, 200);
        assert.strictEqual(links.body.url, pageView.url);
        assert.strictEqual(links.body.untrusted, true);
        assert.deepStrictEqual(links.body.links, [
          { text: 'Safe', href: 'https://example.com/safe' },
          { text: 'Secret', href: 'https://example.com/private' },
        ]);
      }, { pageView });
    },
  },
  {
    name: 'denied human approval never navigates and consumes the confirmation',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations, approvalRequests }) => {
      const token = api.issueToken('navigate');
      const pending = await post('/navigate', token, { url });
      const body = { confirm_id: pending.body.confirm_id };
      const denied = await post('/navigate/confirm', token, body);
      assert.strictEqual(denied.status, 403);
      assert.match(denied.body.error, /human approval denied/);
      assert.deepStrictEqual(navigations, []);
      assert.strictEqual(approvalRequests.length, 1);
      assert.strictEqual(approvalRequests[0].url, url);
      assert.strictEqual((await post('/navigate/confirm', token, body)).status, 400);
    }, { approveNavigation: async () => false }),
  },
  {
    name: 'read tokens cannot request or confirm navigation or consume pending requests',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations, approvalRequests }) => {
      const owner = api.issueToken('navigate');
      const reader = api.issueToken('read');
      assert.strictEqual((await post('/navigate', reader, { url })).status, 403);
      const pending = await post('/navigate', owner, { url });
      assert.strictEqual(pending.status, 200);
      const body = { confirm_id: pending.body.confirm_id };
      assert.strictEqual((await post('/navigate/confirm', reader, body)).status, 403);
      assert.deepStrictEqual(navigations, []);
      assert.strictEqual((await post('/navigate/confirm', owner, body)).status, 200);
      assert.deepStrictEqual(navigations, [url]);
    }),
  },
  ...['navigate', 'full'].map((scope) => ({
    name: `${scope} tokens can confirm their own request exactly once`,
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations, approvalRequests }) => {
      const token = api.issueToken(scope);
      const pending = await post('/navigate', token, { url });
      assert.strictEqual(pending.status, 200);
      assert.strictEqual(pending.body.status, 'pending_confirmation');
      assert.deepStrictEqual(navigations, []);
      const body = { confirm_id: pending.body.confirm_id };
      const replies = await Promise.all([
        post('/navigate/confirm', token, body), post('/navigate/confirm', token, body),
      ]);
      assert.deepStrictEqual(replies.map((r) => r.status).sort(), [200, 400]);
      assert.strictEqual((await post('/navigate/confirm', token, body)).status, 400);
      assert.deepStrictEqual(navigations, [url]);
      assert.strictEqual(approvalRequests.length, 1);
      assert.strictEqual(approvalRequests[0].url, url);
    }),
  })),
  ...['navigate', 'full'].map((scope) => ({
    name: `${scope} tokens cannot confirm another token's request or consume it`,
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations }) => {
      const owner = api.issueToken('navigate');
      const other = api.issueToken(scope);
      const pending = await post('/navigate', owner, { url });
      const body = { confirm_id: pending.body.confirm_id };
      assert.strictEqual((await post('/navigate/confirm', other, body)).status, 403);
      assert.deepStrictEqual(navigations, []);
      assert.strictEqual((await post('/navigate/confirm', owner, body)).status, 200);
      assert.deepStrictEqual(navigations, [url]);
    }),
  })),
  {
    name: 'confirmation expires at its deadline and cannot be replayed',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations, advance }) => {
      const token = api.issueToken('navigate');
      const pending = await post('/navigate', token, { url });
      advance(pending.body.expires_in_ms);
      const body = { confirm_id: pending.body.confirm_id };
      assert.strictEqual((await post('/navigate/confirm', token, body)).status, 400);
      assert.strictEqual((await post('/navigate/confirm', token, body)).status, 400);
      assert.deepStrictEqual(navigations, []);
    }),
  },
  {
    name: 'unknown confirmation cannot navigate',
    gate: 'H',
    fn: (assert) => withApi(async ({ api, post, navigations }) => {
      assert.strictEqual((await post('/navigate/confirm', api.issueToken('navigate'), {
        confirm_id: 'unknown',
      })).status, 400);
      assert.deepStrictEqual(navigations, []);
    }),
  },
];
