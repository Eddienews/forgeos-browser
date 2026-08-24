/*
 * agent-api.js — local-only HTTP endpoint for external agents (v0.4, Phase 25).
 *
 * SECURITY MODEL (see SECURITY_MODEL.md):
 *   - Binds to 127.0.0.1 ONLY. Never exposed to the network.
 *   - Every request must carry the session token:
 *       Authorization: Bearer <token>
 *     The token is generated at browser start and written to
 *     <runtime>/forge-agent-token (mode 0600-ish on Windows: user-only ACLs
 *     by default profile). Agents read it from disk; it is never served.
 *   - READ-ONLY surface by default: navigate / read page / links / status.
 *     Mutating actions go through the same permission gate as UI actions.
 *   - Zero telemetry; requests are logged locally only.
 *
 * Endpoints (all GET unless noted):
 *   GET  /status            → { version, tabs, activeTabId, mode }
 *   GET  /page              → structured Agent View of active tab (untrusted-marked)
 *   GET  /links             → [{href,text}] of active tab
 *   POST /navigate {url}    → navigates active tab (permission gate: OPEN_LINK → auto)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function writeToken(baseDir, token) {
  const file = path.join(baseDir, 'forge-agent-token');
  try {
    fs.writeFileSync(file, token + '\n', 'utf8');
    return file;
  } catch { return null; }
}

/**
 * @param {object} opts
 *  - port (default 8647)
 *  - getSnapshot(): () => state object from main.js buildState()
 *  - readPage(): async () => agent view of the active tab
 *  - navigate(url): promise, performs navigation in active tab
 *  - log: EventLog
 *  - baseDir: where to write forge-agent-token
 */
function startAgentApi({ port = 8647, getSnapshot, readPage, navigate, log, baseDir }) {
  const token = generateToken();
  const tokenFile = writeToken(baseDir, token);
  if (log) log.log('INFO', 'agent api starting', { port, tokenFile });

  const server = http.createServer((req, res) => {
    const deny = (code, msg) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    };
    // 1) localhost only
    const addr = req.socket.remoteAddress || '';
    if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(addr)) return deny(403, 'localhost only');
    // 2) token required
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${token}`) {
      if (log) log.log('DENY', 'agent api bad token', { path: req.url });
      return deny(401, 'invalid or missing bearer token');
    }

    const body = [];
    req.on('data', (c) => { if (body.length < 1e6) body.push(c); });
    req.on('end', async () => {
      try {
        switch (`${req.method} ${req.url.split('?')[0]}`) {
          case 'GET /status': {
            const s = getSnapshot();
            return json(res, {
              product: 'ForgeOS Browser',
              version: process.env.npm_package_version || require(path.join(__dirname, '..', 'package.json')).version,
              mode: s.mode,
              activeTabId: s.activeTabId,
              tabs: s.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, security: t.security.label })),
              counters: s.session,
              untrusted: true,
            });
          }
          case 'GET /page': {
            const view = await readPage();
            return json(res, view); // already marked untrusted by Agent View
          }
          case 'GET /links': {
            const view = await readPage();
            return json(res, { url: view && view.url, links: (view && view.links) || [], untrusted: true });
          }
          case 'POST /navigate': {
            let bodyStr = Buffer.concat(body).toString('utf8') || '{}';
            const { url } = JSON.parse(bodyStr);
            if (!url || !/^https?:\/\//i.test(url)) return deny(400, 'url must be http(s)');
            await navigate(url);
            if (log) log.log('INFO', 'agent api navigated', { url: url.slice(0, 200) });
            return json(res, { ok: true, navigatingTo: url });
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
      resolve({ server, token, port, tokenFile });
    });
  });
}

module.exports = { startAgentApi, generateToken };