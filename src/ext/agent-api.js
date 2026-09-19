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
 *   3. Origin validation — every browser-borne request carrying Origin is
 *      rejected, including opaque null and local file origins.
 *   4. Capability tokens, not a master token:
 *        - versioned, HMAC-signed, TTL-limited (default 60 min)
 *        - scoped per capability: read | navigate | full
 *        - revocable at any time (in-memory revocation list survives until
 *          restart; token file rewrite on rotate)
 *   5. Rate limiting: sliding window per token+IP (default 120 req/min;
 *      429 with Retry-After when exceeded).
 *   6. Response sanitization: cookies/tokens/secrets never appear in output.
 *   7. Every handled request produces one redacted local audit record. Query
 *      strings, bodies, tokens, page content, and destination URLs are omitted.
 *   8. Human approval for navigate: POST /navigate returns
 *      "pending_confirmation" and requires a second authenticated call with
 *      the returned confirm_id within 30s, using the same token with navigate
 *      capability (or full scope). The owning client still cannot navigate
 *      until the browser's trusted UI explicitly approves the destination.
 *   9. Bootstrap credentials are replaced atomically and stored with owner-only
 *      permissions on POSIX systems; the API stays offline if storage fails.
 *  10. The port is reserved before credentials are created; shutdown revokes
 *      capabilities and removes only the token still owned by this instance.
 *
 * Endpoints:
 *   GET  /status                      cap: read
 *   GET  /page                        cap: read
 *   GET  /links                       cap: read
 *   POST /navigate {url}              cap: navigate → pending_confirmation flow
 *   POST /token/rotate                replaces all tokens (cap: full)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureNavigable, UnsafeUrlError } = require('../engine/url-safety');
const { runGoal, createHeuristicDecider } = require('../engine/agent-loop');
const { normalizeSnapshot, elementByIndex } = require('../engine/page-snapshot');
const { classifyAction } = require('../engine/action-policy');
const { filterObservation } = require('../engine/snapshot-filter');

const TOKEN_TTL_MS = 60 * 60 * 1000;          // 60 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 1000;       // 1 minute
const RATE_LIMIT_MAX = 120;                   // requests per window
const CONFIRM_TTL_MS = 30 * 1000;             // navigate confirmation window
const MAX_BODY_BYTES = 64 * 1024;              // API commands are intentionally small
const AUDIT_ROUTES = new Set([
  '/status', '/page', '/links', '/navigate', '/navigate/confirm',
  '/token/issue', '/token/rotate',
]);

function normalizedAuditRoute(requestUrl) {
  const pathname = String(requestUrl || '').split('?')[0];
  return AUDIT_ROUTES.has(pathname) ? pathname : '<unknown>';
}

function normalizedAuditMethod(method) {
  const upper = String(method || '').toUpperCase();
  return /^(GET|POST)$/.test(upper) ? upper : 'OTHER';
}

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

/* Local-only endpoints and the hardening helpers below are shape-checked
 * against the running server; see the module docs for the full model. */

function isAllowedHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  const host = value.toLowerCase();
  const match = host.match(/^(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/)
    || host.match(/^\[::1\](?::(\d{1,5}))?$/);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/**
 * Atomically replace the bootstrap credential without ever writing it through
 * a broadly-readable file. On Windows, the file inherits the directory ACL;
 * POSIX systems additionally enforce mode 0600 before and after replacement.
 */
function writePrivateTokenFile(filePath, contents, {
  fileSystem = fs,
  platform = process.platform,
} = {}) {
  const temporary = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
    if (platform !== 'win32') fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporary, filePath);
    if (platform !== 'win32') fileSystem.chmodSync(filePath, 0o600);
    return platform === 'win32' ? 'inherited-directory-acl' : '0600';
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    try { fileSystem.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

/** Remove a token file only when it still contains this instance's credential. */
function removeOwnedTokenFile(filePath, token, fileSystem = fs) {
  if (!token) return false;
  try {
    const expected = Buffer.from(`scope=full\ntoken=${token}\n`, 'utf8');
    const actual = fileSystem.readFileSync(filePath);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    fileSystem.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// One listener per process. This also closes the race between two concurrent
// calls that would otherwise overwrite the same bootstrap credential.
let activeAgentServer = null;

function startAgentApi({
  port = 8647, getSnapshot, readPage, navigate, approveNavigate,
  observe, act, approveAction,
  log, baseDir, confirmationNow = Date.now, tokenNow = Date.now,
  rateNow = Date.now, auditNow = Date.now, tokenWriter = writePrivateTokenFile,
}) {
  if (activeAgentServer) {
    return Promise.reject(new Error('agent api already running in this process'));
  }
  const masterSecret = generateToken();
  const issued = new Map();   // tokenId -> { scope, expiresAt }
  const revoked = new Set();
  const rateBucket = new Map(); // key -> [timestamps]
  const pendingConfirms = new Map(); // confirmId -> { url, tokenId, expiresAt }

  function issueToken(scope) {
    const id = crypto.randomBytes(8).toString('hex');
    const expiresAt = tokenNow() + TOKEN_TTL_MS;
    const payload = `${id}.${scope}.${expiresAt}`;
    const sig = hmacSign(payload, masterSecret);
    const token = `fgb.${payload}.${sig}`;
    issued.set(id, { scope, expiresAt });
    return token;
  }

  function clearTokenState(id) {
    issued.delete(id);
    for (const [confirmId, pending] of pendingConfirms) {
      if (pending.tokenId === id) pendingConfirms.delete(confirmId);
    }
    for (const key of rateBucket.keys()) {
      if (key.startsWith(`${id}:`)) rateBucket.delete(key);
    }
  }

  /** Returns { ok:true, id, scope } or { ok:false, code, reason }. */
  function verifyToken(token) {
    if (!token || typeof token !== 'string') return { ok: false, code: 401, reason: 'missing bearer token' };
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'fgb') return { ok: false, code: 401, reason: 'malformed token' };
    const [, id, scope, expiresAt, sig] = parts;
    if (revoked.has(id)) return { ok: false, code: 401, reason: 'revoked token' };
    if (!issued.has(id)) return { ok: false, code: 401, reason: 'unknown token' };
    const rec = issued.get(id);
    if (String(rec.expiresAt) !== expiresAt) return { ok: false, code: 401, reason: 'expired token' };
    if (tokenNow() >= rec.expiresAt) {
      clearTokenState(id);
      return { ok: false, code: 401, reason: 'expired token' };
    }
    const expected = hmacSign(`${id}.${scope}.${expiresAt}`, masterSecret);
    if (sig !== expected) return { ok: false, code: 401, reason: 'bad signature' };
    return { ok: true, id, scope: rec.scope };
  }

  function checkRateLimit(key) {
    const now = rateNow();
    const arr = (rateBucket.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) {
      rateBucket.set(key, arr);
      return {
        limited: true,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - arr[0])) / 1000)),
      };
    }
    arr.push(now);
    rateBucket.set(key, arr);
    return { limited: false, remaining: RATE_LIMIT_MAX - arr.length, retryAfterSeconds: 0 };
  }

  const tokenFile = path.join(baseDir, 'forge-agent-token');
  let tokenProtection;
  let bootstrapToken = null;
  let currentBootstrapToken = null;
  let stopPromise = null;

  function rotateCredentials() {
    const priorIds = [...issued.keys()];
    const nextToken = issueToken('full');
    const nextId = nextToken.split('.')[1];
    try {
      tokenProtection = tokenWriter(tokenFile, `scope=full\ntoken=${nextToken}\n`);
    } catch (error) {
      issued.delete(nextId);
      throw error;
    }
    currentBootstrapToken = nextToken;
    for (const id of priorIds) {
      revoked.add(id);
      clearTokenState(id);
    }
    pendingConfirms.clear();
    rateBucket.clear();
    return nextToken;
  }

  const server = http.createServer((req, res) => {
    // Per-request hard timeout: never leave a client hanging.
    const auditStartedAt = auditNow();
    const requestId = crypto.randomBytes(6).toString('hex');
    const auditMethod = normalizedAuditMethod(req.method);
    const auditRoute = normalizedAuditRoute(req.url);
    const requestPath = String(req.url || '').split('?')[0];
    const methodPath = `${req.method} ${requestPath}`;
    let auditScope = 'none';
    let audited = false;

    const auditOnce = (status) => {
      if (audited) return;
      audited = true;
      const elapsed = Number(auditNow()) - Number(auditStartedAt);
      const durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
      const decision = status >= 500 ? 'ERROR' : status >= 400 ? 'DENY' : 'ALLOW';
      try {
        if (log) log.log(decision, 'agent api request', {
          requestId,
          method: auditMethod,
          route: auditRoute,
          decision,
          status,
          scope: auditScope,
          durationMs,
        });
      } catch {}
    };

    req.setTimeout(10000, () => {
      auditOnce(408);
      req.destroy();
    });
    req.once('aborted', () => auditOnce(499));

    const sendJson = (obj) => {
      if (res.writableEnded) return;
      auditOnce(200);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(obj, null, 2));
    };

    const deny = (code, msg, extraHeaders = {}) => {
      if (res.writableEnded) return;
      auditOnce(code);
      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
      };
      res.writeHead(code, headers);
      res.end(JSON.stringify({ error: msg }));
    };

    // 1) loopback only
    const addr = req.socket.remoteAddress || '';
    if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(addr)) return deny(403, 'localhost only');

    // 2) DNS-rebinding defense: Host must be loopback form
    if (!isAllowedHostHeader(req.headers.host)) {
      return deny(403, 'invalid host header');
    }

    // 3) This API is for non-browser clients. Any Origin header, including
    // opaque "null" and local file origins, is rejected as browser-borne.
    if (req.headers.origin !== undefined) {
      return deny(403, 'browser-origin requests not allowed');
    }

    // 4) auth + scope + rate limit — synchronous fast path for denies
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const v = verifyToken(auth);
    if (!v.ok) return deny(v.code, v.reason);
    auditScope = v.scope;

    const rlKey = `${v.id}:${addr}`;
    const rate = checkRateLimit(rlKey);
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    if (rate.limited) {
      return deny(429, 'rate limit exceeded', {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    // Scope enforcement map
    // A trusted native approval dialog may remain open while the user decides.
    if (methodPath === 'POST /navigate/confirm') req.socket.setTimeout(0);
    const needScope = (methodPath === 'POST /act' || methodPath === 'POST /task') ? 'control'
      : (methodPath === 'POST /navigate' || methodPath === 'POST /navigate/confirm') ? 'navigate'
      : (methodPath === 'POST /token/issue' || methodPath === 'POST /token/rotate') ? 'full'
      : 'read';
    if (v.scope !== 'full' && v.scope !== needScope) {
      return deny(403, `token scope '${v.scope}' lacks '${needScope}'`);
    }

    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '');
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        req.resume();
        return deny(415, 'content-type must be application/json');
      }
      const contentLength = req.headers['content-length'];
      if (contentLength !== undefined) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
          req.resume();
          return deny(400, 'invalid content-length');
        }
        if (declaredBytes > MAX_BODY_BYTES) {
          req.resume();
          return deny(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
        }
      }
    }

    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyRejected = false;
    req.on('data', (chunk) => {
      if (bodyRejected) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyRejected = true;
        bodyChunks.length = 0;
        deny(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on('end', async () => {
      if (bodyRejected || res.writableEnded) return;
      try {
        let body = {};
        if (bodyBytes > 0) {
          try {
            body = JSON.parse(Buffer.concat(bodyChunks, bodyBytes).toString('utf8'));
          } catch {
            return deny(400, 'invalid JSON body');
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return deny(400, 'JSON body must be an object');
          }
        }
        switch (methodPath) {
          case 'GET /status': {
            const s = getSnapshot();
            return sendJson(sanitize({
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
            return sendJson(sanitize(view));
          }
          case 'GET /links': {
            const view = await readPage();
            const links = view && view.content && Array.isArray(view.content.links)
              ? view.content.links
              : (view && Array.isArray(view.links) ? view.links : []);
            return sendJson(sanitize({ url: view && view.url, links, untrusted: true }));
          }
          case 'GET /snapshot': {
            // One atomic read of the active tab: its text plus the numbered
            // element table an agent can act on. Reading is automatic.
            if (typeof observe !== 'function') return deny(501, 'agent capabilities unavailable');
            const rawSnap = await observe();
            if (!rawSnap || rawSnap.error) return deny(503, (rawSnap && rawSnap.error) || 'no observation');
            const snap = normalizeSnapshot(rawSnap);
            // The same boundary the loop applies. A page's words reach a model
            // filtered by default on EVERY read path — an unfiltered /snapshot
            // would quietly undo phase 4 for callers that never use /task.
            // ?raw=1 opts out explicitly, for a caller that needs the faithful
            // text (analysis, evidence) and accepts it is hostile input.
            const wantsRaw = /(?:^|[?&])raw=1(?:&|$)/.test(String(req.url || ''));
            let pageText = snap.text;
            let filterInfo = { applied: false };
            if (!wantsRaw) {
              const filtered = filterObservation(snap);
              pageText = filtered.text;
              filterInfo = {
                applied: true,
                safe: filtered.safe,
                removed: filtered.removed,
                injections: filtered.injections.length,
                redactions: [...new Set(filtered.redactions)],
              };
              if (log && (filtered.injections.length || filtered.redactions.length)) {
                log.log('INFO', 'observation filtered on read', {
                  injections: filtered.injections.length, redactions: filtered.redactions.length, route: 'GET /snapshot',
                });
              }
            }
            return sendJson({
              url: snap.url,
              title: snap.title,
              text: pageText,
              elements: (snap.elements || []).map((el) => ({
                index: el.index, kind: el.kind, role: el.role, label: el.label,
                current_value: el.current_value, option_value: el.option_value, href: el.href,
              })),
              can_scroll_down: snap.can_scroll_down,
              can_scroll_up: snap.can_scroll_up,
              fingerprint: snap.fingerprint,
              truncated: !!snap.truncated,
              filter: filterInfo,
              // These words were written by a stranger. Treat them as data.
              untrusted: true,
              instruction_authority: 'none',
            });
          }
          case 'POST /act': {
            if (typeof observe !== 'function' || typeof act !== 'function') {
              return deny(501, 'agent capabilities unavailable');
            }
            // Observe first: a target index is only meaningful against the page
            // as it is NOW, and the element's own label is what the risk policy
            // judges — never the caller's description of it.
            const rawCurrent = await observe();
            if (!rawCurrent || rawCurrent.error) return deny(503, (rawCurrent && rawCurrent.error) || 'no observation');
            const current = normalizeSnapshot(rawCurrent);
            const element = elementByIndex(current, body.target);
            if (!element) return deny(400, `target [${body.target}] is not in the current page`);

            const op = String(body.operation || '').toUpperCase();
            const kind = op === 'CLICK' ? 'click' : op === 'TYPE_TEXT' ? 'fill' : op === 'SELECT' ? 'select'
              : op === 'SCROLL_DOWN' || op === 'SCROLL_UP' || op === 'WAIT' ? 'scroll_or_wait' : null;
            if (!kind) return deny(400, 'operation must be one of CLICK, TYPE_TEXT, SELECT, SCROLL_UP, SCROLL_DOWN, WAIT');
            if (kind === 'fill' && element.kind !== 'fill') return deny(400, `[${element.index}] is not fillable (${element.kind})`);
            if (kind === 'select' && element.kind !== 'select') return deny(400, `[${element.index}] is not selectable (${element.kind})`);
            if (kind === 'click' && element.kind !== 'click') return deny(400, `[${element.index}] is not clickable (${element.kind})`);

            const action = kind === 'scroll_or_wait'
              ? { kind: op === 'WAIT' ? 'wait' : 'scroll', direction: op === 'SCROLL_UP' ? 'up' : 'down' }
              : {
                  kind,
                  targetIndex: element.index,
                  value: kind === 'select' ? (body.option_value != null ? body.option_value : body.value) : body.value,
                  label: element.label,
                  signal: { label: element.label, href: element.href || '', isSubmit: false, type: element.role === 'textbox' ? 'text' : '' },
                  fingerprint: current.fingerprint,
                };

            const policy = classifyAction(action);
            if (policy.risk === 'approval') {
              if (typeof approveAction !== 'function') {
                return deny(403, `action requires human approval (${policy.why}) and no approver is available`);
              }
              if (log) log.log('ASK', 'agent action awaiting human decision', { kind: action.kind, label: action.label || '', why: policy.why });
              req.socket.setTimeout(0); // the dialog stays open until the user decides
              const allowed = await approveAction({ action, policy });
              if (!allowed) return deny(403, `a human declined this action: ${policy.why}`);
            }

            const outcome = await act(action);
            // Every action the agent takes is recorded, automatic or approved:
            // an audit trail with holes is not an audit trail.
            if (log) {
              log.log(outcome && outcome.ok ? 'INFO' : 'DENY', 'agent action executed', {
                operation: op,
                target: element.index,
                label: String(element.label || '').slice(0, 120),
                risk: policy.risk,
                outcome: outcome && outcome.ok ? 'ok' : 'refused',
                detail: String((outcome && (outcome.detail || outcome.reason)) || '').slice(0, 160),
              });
            }
            return sendJson({
              status: outcome && outcome.ok ? 'done' : 'refused',
              operation: op,
              target: element.index,
              label: element.label,
              risk: policy.risk,
              why: policy.why,
              detail: (outcome && (outcome.detail || outcome.reason)) || '',
              fingerprint_before: current.fingerprint,
            });
          }
          case 'POST /task': {
            if (typeof observe !== 'function' || typeof act !== 'function') {
              return deny(501, 'agent capabilities unavailable');
            }
            const goal = String(body.goal || '').trim();
            if (!goal) return deny(400, 'goal is required');
            const maxSteps = Math.max(1, Math.min(Number(body.max_steps) || 12, 30));
            // The loop may stop for a human mid-run, so the socket must outlive
            // the default timeout.
            req.socket.setTimeout(0);
            const result = await runGoal({
              goal: goal.slice(0, 1000),
              observe,
              act,
              decide: createHeuristicDecider(),
              requestApproval: typeof approveAction === 'function'
                ? async (info) => approveAction(info)
                : async () => false,
              log: (line) => { if (log) log.log('INFO', 'agent task step', { line: String(line).slice(0, 200) }); },
            }, { maxSteps });
            return sendJson({
              status: result.status,
              result: result.result,
              note: result.note,
              steps: result.steps,
              evidence: result.evidence,
              filter: result.filter,
              untrusted: true,
            });
          }
          case 'POST /navigate': {
            const { url } = body;
            if (!url || !/^https?:\/\//i.test(url)) return deny(400, 'url must be http(s)');
            // SSRF defense: this URL was chosen by a model, not typed by a
            // person. Refuse destinations an agent must never reach — cloud
            // metadata (169.254.169.254), loopback, and private networks —
            // because the response is readable back through GET /page.
            try {
              await ensureNavigable(url);
            } catch (err) {
              if (err instanceof UnsafeUrlError) {
                if (log) log.log('DENY', 'agent navigation refused by url safety', { url: String(url).slice(0, 200), reason: err.message.slice(0, 200) });
                return deny(403, `destination refused: ${err.message}`);
              }
              throw err;
            }
            // Confirmation flow: first call returns pending_confirmation.
            const confirmId = crypto.randomBytes(12).toString('hex');
            pendingConfirms.set(confirmId, { url, tokenId: v.id, expiresAt: confirmationNow() + CONFIRM_TTL_MS });
            return sendJson({
              status: 'pending_confirmation',
              confirm_id: confirmId,
              expires_in_ms: CONFIRM_TTL_MS,
              how_to_confirm: `POST /navigate/confirm {"confirm_id":"${confirmId}"}`,
            });
          }
          case 'POST /navigate/confirm': {
            const { confirm_id } = body;
            const pend = pendingConfirms.get(confirm_id);
            if (!pend) return deny(400, 'unknown or expired confirm_id');
            // A different caller must not execute or consume the owner's request.
            if (pend.tokenId !== v.id) return deny(403, 'confirmation belongs to another token');
            // Consume before awaiting navigation so concurrent confirmations cannot replay it.
            pendingConfirms.delete(confirm_id);
            if (confirmationNow() >= pend.expiresAt) return deny(400, 'confirmation expired');
            if (typeof approveNavigate !== 'function') return deny(503, 'human approval unavailable');
            const approved = await approveNavigate(pend.url, { tokenId: v.id });
            if (!approved) return deny(403, 'human approval denied');
            await navigate(pend.url);
            return sendJson({ ok: true, navigatingTo: pend.url });
          }
          case 'POST /token/issue': {
            // Only 'full'-scope tokens can mint new ones.
            if (v.scope !== 'full') return deny(403, 'requires full scope');
            const { scope } = body;
            const allowedScopes = ['read', 'navigate', 'control'];
            if (!allowedScopes.includes(scope)) return deny(400, `scope must be one of ${allowedScopes}`);
            return sendJson({ token: issueToken(scope), ttl_minutes: TOKEN_TTL_MS / 60000, scope });
          }
          case 'POST /token/rotate': {
            try {
              const token = rotateCredentials();
              return sendJson({
                ok: true,
                rotated: true,
                token,
                scope: 'full',
                ttl_minutes: TOKEN_TTL_MS / 60000,
              });
            } catch (error) {
              return deny(503, 'secure token rotation failed');
            }
          }
          default:
            return deny(404, 'unknown endpoint');
        }
      } catch (e) {
        return deny(500, String(e).slice(0, 200));
      }
    });
  });

  function stop() {
    if (stopPromise) return stopPromise;
    for (const id of issued.keys()) revoked.add(id);
    issued.clear();
    pendingConfirms.clear();
    rateBucket.clear();
    const tokenRemoved = removeOwnedTokenFile(tokenFile, currentBootstrapToken);
    currentBootstrapToken = null;
    stopPromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve({ tokenRemoved });
        return;
      }
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve({ tokenRemoved });
      });
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    return stopPromise;
  }

  activeAgentServer = server;
  server.once('close', () => {
    if (activeAgentServer === server) activeAgentServer = null;
    removeOwnedTokenFile(tokenFile, currentBootstrapToken);
    currentBootstrapToken = null;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const failStartup = (error) => {
      if (settled) return;
      settled = true;
      if (activeAgentServer === server) activeAgentServer = null;
      reject(new Error(`agent api failed to bind: ${error.message}`));
    };
    server.once('error', failStartup);
    try {
      server.listen(port, '127.0.0.1', () => {
        if (settled) return;
        server.off('error', failStartup);
        try {
          // Bind succeeds before the credential is created, so a failed or
          // duplicate listener can never overwrite a working instance's token.
          bootstrapToken = issueToken('full');
          currentBootstrapToken = bootstrapToken;
          tokenProtection = tokenWriter(tokenFile, `scope=full\ntoken=${bootstrapToken}\n`);
        } catch (error) {
          settled = true;
          removeOwnedTokenFile(tokenFile, bootstrapToken);
          currentBootstrapToken = null;
          issued.clear();
          if (log) log.log('ERROR', 'agent api secure token storage failed', { error: String(error).slice(0, 160) });
          server.close(() => reject(new Error(`agent api secure token storage failed: ${error.message}`)));
          return;
        }
        settled = true;
        server.on('error', (error) => {
          if (log) log.log('ERROR', 'agent api server error', { error: String(error).slice(0, 160) });
        });
        if (log) log.log('INFO', 'agent api hardened start', {
          port: server.address().port,
          capabilities: 'read|navigate|full',
          ttlMinutes: TOKEN_TTL_MS / 60000,
          tokenProtection,
        });
        resolve({
          server,
          port: server.address().port,
          tokenFile,
          tokenProtection,
          bootstrapToken,
          issueToken,
          verifyToken,
          stop,
        });
      });
    } catch (error) {
      failStartup(error);
    }
  });
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  MAX_BODY_BYTES, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
  isAllowedHostHeader, normalizedAuditMethod, normalizedAuditRoute, removeOwnedTokenFile,
  startAgentApi, generateToken, writePrivateTokenFile,
};
