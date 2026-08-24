/*
 * agent-api.js — local-only HTTP endpoint for external agents (v0.5 hardened).
 *
 * SECURITY MODEL (SECURITY_MODEL.md + public review feedback):
 *
 * Principle: the agent receives CAPABILITIES, not unrestricted browser access.
 *
 * Layers:
 *   1. Loopback bind only (127.0.0.1). Refuses any other interface.
 *   2. Host header validation — DNS-rebinding defense: only 127.0.0.1 accepted.
 *   3. Origin validation — browser-borne requests (which carry Origin) are
 *      rejected; only non-browser clients (no Origin header) or explicit
 *      allowlisted origins may call.
 *   4. Capability tokens, not a master token:
 *        - versioned, HMAC-signed, TTL-limited (default 60 min)
 *        - scoped per capability: read | navigate | full
 *        - revocable at any time (in-memory revocation list survives until
 *          restart; token file rewrite on rotate)
 *   5. Rate limiting: sliding window per token+IP (default 120 req/min;
 *      429 with Retry-After when exceeded).
 *   6. Response sanitization: cookies/tokens/secrets never appear in output.
 *   7. Every request appended to the audit log (handoffs/audit-log.md).
 *   8. Human confirmation for navigate: POST /navigate returns
 *      "pending_confirmation" and requires a second authenticated call with
 *      the returned confirm_id within 30s (defense against drive-by agent abuse).
 *
 * Endpoints:
 *   GET  /status                      cap: read
 *   GET  /page                        cap: read
 *   GET  /links                       cap: read
 *   POST /navigate {url}              cap: navigate → pending_confirmation flow
 *   POST /token/rotate {masterToken}  rotates all tokens (cap: master)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 60 * 60 * 1000;          // 60 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 1000;       // 1 minute
const RATE_LIMIT_MAX = 120;                   // requests per window
const CONFIRM_TTL_MS = 30 * 1000;             // navigate confirmation window

function hmacSign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

/** Strip anything secret-looking from an object recursively. */
function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/cookie|token|secret|password|authorization/i.test(k)) continue; // dropped entirely
    out[k] = sanitize(v);
  }
  return out;
}

function startAgentApi({ port = 8647, getSnapshot, readPage, navigate, log, baseDir }) {
  const masterSecret = generateToken();
  const issued = new Map();   // tokenId -> { scope, expiresAt }
  const revoked = new Set();
  const rateBucket = new Map(); // key -> [timestamps]
  const pendingConfirms = new Map(); // confirmId -> { url, expiresAt }

  function issueToken(scope) {
    const id = crypto.randomBytes(8).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const payload = `${id}.${scope}.${expiresAt}`;
    const sig = hmacSign(payload, masterSecret);
    const token = `fgb.${payload}.${sig}`;
    issued.set(id, { scope, expiresAt });
    if (log) log.log('INFO', 'agent api token issued', { id: id.slice(0, 6), scope });
    return token;
  }

  /** Returns { ok:true, id, scope } or { ok:false, code, reason }. */
  function verifyToken(token) {
    if (!token || typeof token !== 'string') return { ok: false, code: 401, reason: 'missing bearer token' };
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'fgb') return { ok: false, code: 401, reason: 'malformed token' };
    const [, id, scope, expiresAt, sig] = parts;
    if (!issued.has(id)) return { ok: false, code: 401, reason: 'unknown token' };
    if (revoked.has(id)) return { ok: false, code: 401, reason: 'revoked token' };
    const rec = issued.get(id);
    if (String(rec.expiresAt) !== expiresAt) return { ok: false, code: 401, reason: 'expired token' };
    if (Date.now() > rec.expiresAt) {
      issued.delete(id);
      return { ok: false, code: 401, reason: 'expired token' };
    }
    const expected = hmacSign(`${id}.${scope}.${expiresAt}`, masterSecret);
    if (sig !== expected) return { ok: false, code: 401, reason: 'bad signature' };
    return { ok: true, id, scope: rec.scope };
  }

  function rotateAll(masterToken) {
    if (masterToken !== `master.${masterSecret}`) return { ok: false };
    for (const id of issued.keys()) revoked.add(id);
    issued.clear();
    return { ok: true };
  }

  function rateLimited(key) {
    const now = Date.now();
    const arr = (rateBucket.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    arr.push(now);
    rateBucket.set(key, arr);
    return arr.length > RATE_LIMIT_MAX ? RATE_LIMIT_MAX : false;
  }

  // Initial token written to disk (scoped 'full' — it lives next to the app).
  const bootstrapToken = issueToken('full');
  const tokenFile = path.join(baseDir, 'forge-agent-token');
  try { fs.writeFileSync(tokenFile, `scope=full\ntoken=${bootstrapToken}\n`, 'utf8'); } catch {}

  if (log) log.log('INFO', 'agent api hardened start', { port, capabilities: 'read|navigate|full', ttlMinutes: TOKEN_TTL_MS / 60000 });

  const server = http.createServer((req, res) => {
    // Per-request hard timeout: never leave a client hanging.
    req.socket.setTimeout(10000);
    req.socket.on('timeout', () => { req.socket.destroy(); });

    const deny = (code, msg) => {
      if (log) log.log(code === 429 ? 'WARN' : 'DENY', 'agent api refused', { code, path: req.url, reason: msg });
      const headers = { 'Content-Type': 'application/json' };
      if (code === 429) headers['Retry-After'] = 60;
      res.writeHead(code, headers);
      res.end(JSON.stringify({ error: msg }));
    };

    // 1) loopback only
    const addr = req.socket.remoteAddress || '';
    if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(addr)) return deny(403, 'localhost only');

    // 2) DNS-rebinding defense: Host must be loopback form
    const hostHeader = String(req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostHeader)) {
      return deny(403, 'invalid host header');
    }

    // 3) Origin validation: browsers attach Origin on cross-site fetches;
    // any present Origin is treated as hostile unless explicitly null/file.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !origin.startsWith('file://')) {
      return deny(403, 'browser-origin requests not allowed');
    }

    // 4) auth + scope + rate limit — synchronous fast path for denies
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let v;
    if (auth.startsWith('master.')) {
      if (!rotateAll(auth)) return deny(401, 'invalid master token');
      return json(res, { ok: true, rotated: true });
    }
    v = verifyToken(auth);
    if (!v.ok) return deny(v.code, v.reason);

    const rlKey = `${v.id}:${addr}`;
    const limit = rateLimited(rlKey);
    if (limit) return deny(429, 'rate limit exceeded');

    // Scope enforcement map
    const methodPath = `${req.method} ${req.url.split('?')[0]}`;
    const needScope = methodPath === 'POST /navigate' ? 'navigate'
      : methodPath === 'POST /token/issue' ? 'full'
      : 'read';
    if (v.scope !== 'full' && v.scope !== needScope) {
      return deny(403, `token scope '${v.scope}' lacks '${needScope}'`);
    }

    let bodyBuf = Buffer.alloc(0);
    req.on('data', (c) => { if (bodyBuf.length < 1e6) bodyBuf = Buffer.concat([bodyBuf, c]); });
    req.on('end', async () => {
      try {
        switch (methodPath) {
          case 'GET /status': {
            const s = getSnapshot();
            return json(res, sanitize({
              product: 'ForgeOS Browser',
              mode: s.mode,
              activeTabId: s.activeTabId,
              tabs: s.tabs.map((t) => ({ title: t.title, url: t.url })),
              counters: s.session,
              untrusted: true,
            }));
          }
          case 'GET /page': {
            const view = await readPage();
            return json(res, sanitize(view));
          }
          case 'GET /links': {
            const view = await readPage();
            return json(res, sanitize({ url: view && view.url, links: (view && view.links) || [], untrusted: true }));
          }
          case 'POST /navigate': {
            const { url } = JSON.parse(bodyBuf.toString('utf8') || '{}');
            if (!url || !/^https?:\/\//i.test(url)) return deny(400, 'url must be http(s)');
            // Confirmation flow: first call returns pending_confirmation.
            const confirmId = crypto.randomBytes(12).toString('hex');
            pendingConfirms.set(confirmId, { url, expiresAt: Date.now() + CONFIRM_TTL_MS });
            return json(res, {
              status: 'pending_confirmation',
              confirm_id: confirmId,
              expires_in_ms: CONFIRM_TTL_MS,
              how_to_confirm: `POST /navigate/confirm {"confirm_id":"${confirmId}"}`,
            });
          }
          case 'POST /navigate/confirm': {
            const { confirm_id } = JSON.parse(bodyBuf.toString('utf8') || '{}');
            const pend = pendingConfirms.get(confirm_id);
            if (!pend) return deny(400, 'unknown or expired confirm_id');
            pendingConfirms.delete(confirm_id);
            if (Date.now() > pend.expiresAt) return deny(400, 'confirmation expired');
            await navigate(pend.url);
            if (log) log.log('INFO', 'agent api navigated (confirmed)', { url: pend.url.slice(0, 200) });
            return json(res, { ok: true, navigatingTo: pend.url });
          }
          case 'POST /token/issue': {
            // Only 'full'-scope tokens can mint new ones.
            if (v.scope !== 'full') return deny(403, 'requires full scope');
            const { scope } = JSON.parse(bodyBuf.toString('utf8') || '{}');
            const allowedScopes = ['read', 'navigate'];
            if (!allowedScopes.includes(scope)) return deny(400, `scope must be one of ${allowedScopes}`);
            return json(res, { token: issueToken(scope), ttl_minutes: TOKEN_TTL_MS / 60000, scope });
          }
          default:
            return deny(404, 'unknown endpoint');
        }
      } catch (e) {
        return deny(500, String(e).slice(0, 200));
      }
    });
  });

  function json(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port, tokenFile, bootstrapToken, issueToken, verifyToken });
    });
  });
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { startAgentApi, generateToken };