/* Mandatory, per-agent HTTP proxy. Not an SSRF fix until every agent network path
 * is isolated in an Electron session configured with proxyConfig() before use. */
'use strict';
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { isAlwaysBlocked, isPrivate } = require('./url-safety');

const denied = (message = 'Destination denied') => Object.assign(new Error(message), { statusCode: 403 });
const invalid = () => Object.assign(new Error('Invalid proxy request'), { statusCode: 400 });
const bareIP = (host) => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
const normalizedIP = (address) => {
  const ip = bareIP(address).toLowerCase();
  if (net.isIP(ip) === 6) return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return ip;
};

// An allow-by-default public-looking address is not sufficient: refuse special-use
// and non-global ranges as well as the private/link-local classes in url-safety.
function isPublicAddress(value) {
  const ip = bareIP(value);
  const family = net.isIP(ip);
  if (!family || isAlwaysBlocked(ip) || isPrivate(ip)) return false;
  if (family === 6) {
    const canonical = normalizedIP(ip);
    const groups = canonical.split('::');
    const first = parseInt(groups[0], 16);
    // IPv4-mapped IPv6 inherits every IPv4 prohibition.
    if (canonical.startsWith('::ffff:')) {
      const hex = canonical.slice(7).split(':');
      const a = parseInt(hex[0], 16), b = parseInt(hex[1], 16);
      return isPublicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    const second = parseInt(canonical.split(':')[1], 16);
    return (first & 0xe000) === 0x2000 &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      first !== 0x2002 && first !== 0x3fff;
  }
  const [a, b, c] = ip.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

function authority(text, requirePort = false) {
  if (typeof text !== 'string' || text.length > 260 || /[\s\\@/?#]/.test(text)) throw invalid();
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(text);
  if (!match || (requirePort && !match[2])) throw invalid();
  const host = bareIP(match[1]).toLowerCase();
  if (match[1].startsWith('[') ? net.isIP(host) !== 6 :
    (!net.isIP(host) && (!/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)*\.?$/.test(host) || host.split('.').some((s) => s.endsWith('-'))))) throw invalid();
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) throw invalid();
  return { host, port };
}
function sameAuthority(a, b, defaultPort) {
  return a.host === b.host && (a.port || defaultPort) === (b.port || defaultPort);
}
function assertHost(request, target, defaultPort) {
  const hosts = request.rawHeaders.filter((h) => h.toLowerCase() === 'host');
  if (hosts.length !== 1 || !sameAuthority(authority(request.headers.host), target, defaultPort)) throw invalid();
}
// Accept exactly a TLS ClientHello before forwarding CONNECT bytes. A tunnel
// with a different SNI must never be offered to the chosen upstream socket.
function clientHelloSNI(bytes) {
  if (bytes.length < 5) return null;
  if (bytes[0] !== 22 || bytes[1] !== 3 || bytes.readUInt16BE(3) > 16384) throw invalid();
  const end = 5 + bytes.readUInt16BE(3);
  if (bytes.length < end) return null;
  const hello = bytes.subarray(5, end);
  if (hello[0] !== 1 || hello.readUIntBE(1, 3) + 4 > hello.length) throw invalid();
  let offset = 4;
  const take = (size) => { if (offset + size > hello.length) throw invalid(); const result = hello.subarray(offset, offset + size); offset += size; return result; };
  take(2 + 32);
  take(take(1)[0]);
  take(take(2).readUInt16BE(0));
  take(take(1)[0]);
  const extensionLength = take(2).readUInt16BE(0);
  const extensionsEnd = offset + extensionLength;
  if (extensionsEnd > hello.length) throw invalid();
  while (offset < extensionsEnd) {
    const type = take(2).readUInt16BE(0);
    const length = take(2).readUInt16BE(0);
    const ext = take(length);
    if (type !== 0) continue;
    if (ext.length < 5 || ext.readUInt16BE(0) !== ext.length - 2 || ext[2] !== 0 || ext.readUInt16BE(3) !== ext.length - 5) throw invalid();
    const rawName = ext.subarray(5);
    if (rawName.some((byte) => byte > 0x7f)) throw invalid();
    const name = rawName.toString('ascii');
    if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw invalid();
    return { name: name.toLowerCase().replace(/\.$/, ''), length: end };
  }
  return { name: null, length: end };
}
function rejectSocket(socket, error) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.statusCode || 502} ${error.statusCode === 400 ? 'Bad Request' : error.statusCode === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}
function proxyConfig(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Proxy must be listening');
  // No direct:// fallback. Chromium normally bypasses localhost implicitly;
  // <-loopback> removes that bypass so localhost reaches this proxy and is denied.
  return { mode: 'fixed_servers', proxyRules: `127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' };
}
function createAgentNetworkProxy({ resolver = (host) => dns.promises.lookup(host, { all: true }), dial = (options) => net.connect(options), connectTimeoutMs = 5000 } = {}) {
  if (typeof resolver !== 'function' || typeof dial !== 'function') throw new TypeError('Invalid network dependency');
  let server, stopping = false;
  const sockets = new Set();
  async function addresses(host) {
    if (host === 'localhost' || host.endsWith('.localhost')) throw denied();
    const literal = net.isIP(host);
    const get = async () => {
      if (literal) return [host];
      const result = await resolver(host);
      if (!Array.isArray(result) || !result.length) throw denied();
      const values = result.map((r) => typeof r === 'string' ? r : r?.address);
      if (values.some((ip) => !isPublicAddress(ip))) throw denied();
      return values.map(normalizedIP).sort();
    };
    const first = await get();
    if (first.some((ip) => !isPublicAddress(ip))) throw denied();
    const second = await get();
    if (first.join(',') !== second.join(',')) throw denied('DNS answers changed');
    return first;
  }
  async function connect(host, port) {
    const ips = await addresses(host);
    const chosen = ips[0];
    // Never supply the DNS hostname to net.connect: the checked IP is pinned.
    const socket = dial({ host: chosen, port, family: net.isIP(chosen) });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(connectTimeoutMs, () => socket.destroy(new Error('Connect timeout')));
    try {
      await new Promise((resolve, reject) => {
        if (socket.readyState === 'open') return resolve();
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Connection closed')));
      });
      if (normalizedIP(socket.remoteAddress || '') !== chosen || !isPublicAddress(socket.remoteAddress)) throw denied('Connected address mismatch');
      socket.setTimeout(0);
      return socket;
    } catch (error) { socket.destroy(); throw error; }
  }
  async function handleHTTP(req, res) {
    try {
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(req.method) || !/^http:\/\//i.test(req.url) || /[\r\n]/.test(req.url)) throw invalid();
      const url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password || url.hash || !url.hostname) throw invalid();
      const target = authority(url.host);
      assertHost(req, target, 80);
      const upstream = await connect(target.host, target.port || 80);
      if (res.destroyed) { upstream.destroy(); return; }
      const excluded = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
      for (const token of String(req.headers.connection || '').split(',')) excluded.add(token.trim().toLowerCase());
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !excluded.has(name)));
      headers.host = req.headers.host;
      headers.connection = 'close';
      const pinnedAgent = new http.Agent({ keepAlive: false });
      pinnedAgent.createConnection = () => upstream;
      const outgoing = http.request({ host: target.host, port: target.port || 80, method: req.method,
        path: url.pathname + url.search, headers, agent: pinnedAgent }, (response) => {
        const responseHeaders = { ...response.headers, connection: 'close' };
        delete responseHeaders['proxy-authenticate'];
        res.writeHead(response.statusCode, responseHeaders);
        response.pipe(res);
      });
      outgoing.on('error', () => { upstream.destroy(); if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => outgoing.destroy());
      req.pipe(outgoing);
    } catch (error) { if (!res.headersSent) res.writeHead(error.statusCode || 502); res.end(); }
  }
  async function handleCONNECT(req, client, head) {
    try {
      const target = authority(req.url, true);
      assertHost(req, target, target.port);
      const upstream = await connect(target.host, target.port);
      if (client.destroyed) { upstream.destroy(); return; }
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Inspect (but never rewrite) TLS ClientHello. No application byte reaches
      // the upstream until SNI agrees with CONNECT's authority.
      let pending = head;
      client.setTimeout(connectTimeoutMs, () => client.destroy());
      const inspect = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 65536) { client.destroy(); upstream.destroy(); return; }
        try {
          const hello = clientHelloSNI(pending);
          if (!hello) return;
          if (net.isIP(target.host) ? (hello.name && hello.name !== target.host) : hello.name !== target.host.replace(/\.$/, '')) throw denied('SNI mismatch');
          client.off('data', inspect);
          client.setTimeout(0);
          upstream.write(pending);
          client.pipe(upstream).pipe(client);
        } catch { client.destroy(); upstream.destroy(); }
      };
      client.on('data', inspect);
      if (head.length) { pending = Buffer.alloc(0); inspect(head); }
    } catch (error) { rejectSocket(client, error); }
  }
  return {
    isListening() { return !!server && server.listening && !stopping; },
    async start() {
      if (server || stopping) throw new Error('Proxy already started or stopping');
      server = http.createServer(handleHTTP);
      server.on('connect', handleCONNECT);
      server.on('upgrade', (_req, socket) => rejectSocket(socket, denied()));
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
      } catch (error) { server = null; throw error; }
      return { host: '127.0.0.1', port: server.address().port, proxyConfig: proxyConfig(server.address().port) };
    },
    async stop() {
      if (!server) return;
      stopping = true;
      const old = server;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => old.close(resolve));
      server = null;
      stopping = false;
    },
  };
}
// An agent session is only returned once its dedicated proxy is listening and
// Electron confirms that both public and loopback URLs use that exact proxy.
function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
async function createAgentSession({ session, proxyFactory = createAgentNetworkProxy, probe = tcpProbe } = {}) {
  const proxy = proxyFactory();
  let port;
  try {
    const started = await proxy.start();
    port = started.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        started.proxyConfig?.mode !== 'fixed_servers' ||
        started.proxyConfig.proxyRules !== `127.0.0.1:${port}` ||
        started.proxyConfig.proxyBypassRules !== '<-loopback>') throw new Error('Agent proxy configuration invalid');
    const partition = `forge-agent-${crypto.randomBytes(16).toString('hex')}`;
    const ses = session.fromPartition(partition);
    if (ses.isPersistent && ses.isPersistent()) throw new Error('Agent session must be nonpersistent');
    await ses.setProxy(started.proxyConfig);
    const lease = {
      session: ses, partition, port, proxy,
      async assertReady() {
        if (typeof proxy.isListening === 'function' && !proxy.isListening()) throw new Error('Agent proxy unavailable; navigate again to create a protected agent tab');
        if (!await probe(port)) throw new Error('Agent proxy unavailable; navigate again to create a protected agent tab');
        if (typeof ses.resolveProxy !== 'function') throw new Error('Agent session proxy verification unavailable');
        for (const url of ['http://127.0.0.1/', 'https://example.com/']) {
          const rule = await ses.resolveProxy(url);
          if (rule !== `PROXY 127.0.0.1:${port}`) throw new Error('Agent session proxy bypass detected');
        }
      },
      stop: () => proxy.stop(),
    };
    await lease.assertReady();
    return lease;
  } catch (error) {
    await proxy.stop().catch(() => {});
    throw error;
  }
}
module.exports = { createAgentNetworkProxy, createAgentSession, proxyConfig, isPublicAddress };
