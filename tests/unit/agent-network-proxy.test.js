'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const tests = [];
const test = (name, fn) => tests.push({ name, gate: 'Agent network proxy', fn });
module.exports = tests;
const { createAgentNetworkProxy, isPublicAddress } = require('../../src/engine/agent-network-proxy');

function raw(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (bytes) => { data += bytes; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
async function withProxy(options, run) {
  const proxy = createAgentNetworkProxy(options);
  const started = await proxy.start();
  try { await run(started); } finally { await proxy.stop(); }
}
const httpRequest = (url, host) => `GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
const connectRequest = (host) => `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

test('special-use and mapped IPv6 addresses fail closed', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '0.1.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '2001:db8::1', 'invalid']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('HTTP absolute-form and CONNECT refuse loopback/private/link-local and malformed or mismatched authorities without dialing', async () => {
  let attempts = 0;
  await withProxy({ resolver: async () => [{ address: '127.0.0.1' }], dial: () => { attempts++; throw Error('must not dial'); } }, async ({ port, proxyConfig }) => {
    assert.equal(proxyConfig.mode, 'fixed_servers');
    assert.match(proxyConfig.proxyRules, /^127\.0\.0\.1:\d+$/);
    assert.equal(proxyConfig.proxyBypassRules, '<-loopback>');
    assert.doesNotMatch(JSON.stringify(proxyConfig), /direct:\/\//i);
    for (const target of ['127.0.0.1', '169.254.169.254', '[::1]', '[::ffff:7f00:1]', '[fe80::1]', 'localhost', 'private.test']) {
      const authority = target.startsWith('[') ? `${target}:443` : `${target}:443`;
      assert.match(await raw(port, httpRequest(`http://${target}/secret`, target)), /^HTTP\/1\.1 403/, target);
      assert.match(await raw(port, connectRequest(authority)), /^HTTP\/1\.1 403/, target);
    }
    for (const payload of [
      httpRequest('http://public.test/', 'other.test'),
      httpRequest('http://public.test/', 'public.test:81'),
      httpRequest('http://public.test/', 'public.test\r\nHost: public.test'),
      connectRequest('public.test:0'), connectRequest('public.test:65536'),
      connectRequest('public.test'),
      'CONNECT public.test:443 HTTP/1.1\r\nHost: other.test:443\r\n\r\n',
    ]) assert.match(await raw(port, payload), /^HTTP\/1\.1 400/);
    assert.equal(attempts, 0);
  });
});

test('mixed public/private DNS and changes between lookups are denied before dial', async () => {
  let calls = 0, attempts = 0;
  await withProxy({ resolver: async () => ++calls <= 2 ? [{ address: '8.8.8.8' }, { address: '127.0.0.1' }] : [{ address: calls % 2 ? '8.8.8.8' : '1.1.1.1' }], dial: () => { attempts++; throw Error('must not dial'); } }, async ({ port }) => {
    assert.match(await raw(port, connectRequest('mixed.test:443')), /^HTTP\/1\.1 403/);
    assert.match(await raw(port, connectRequest('change.test:443')), /^HTTP\/1\.1 403/);
    assert.equal(attempts, 0);
  });
});

test('pinned literal dial rejects a different connected remoteAddress before CONNECT success or HTTP forwarding', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => { upstreamHits++; res.end('secret'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dial = ({ host, port }) => {
    assert.equal(host, '8.8.8.8');
    assert.equal(port, 443);
    return net.connect(upstream.address().port, '127.0.0.1');
  };
  try {
    await withProxy({ dial }, async ({ port }) => {
      assert.match(await raw(port, connectRequest('8.8.8.8:443')), /^HTTP\/1\.1 403/);
      assert.equal(upstreamHits, 0);
    });
  } finally { await new Promise((resolve) => upstream.close(resolve)); }
});

test('HTTP redirects are revalidated on each request; denied target server receives zero requests', async () => {
  let hits = 0;
  const forbidden = http.createServer((_req, res) => { hits++; res.end('forbidden'); });
  await new Promise((resolve) => forbidden.listen(0, '127.0.0.1', resolve));
  try {
    await withProxy({}, async ({ port }) => {
      const target = `127.0.0.1:${forbidden.address().port}`;
      assert.match(await raw(port, httpRequest(`http://${target}/redirected`, target)), /^HTTP\/1\.1 403/);
      assert.equal(hits, 0);
    });
  } finally { await new Promise((resolve) => forbidden.close(resolve)); }
});

test('synthetic pinned HTTP route preserves Host and origin-form path', async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { host: req.headers.host, url: req.url };
    res.writeHead(302, { location: 'http://127.0.0.1/denied' });
    res.end('redirect');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const dial = ({ host, port }) => {
      assert.equal(host, '8.8.8.8');
      assert.equal(port, 80);
      const socket = net.connect(upstream.address().port, '127.0.0.1');
      // Synthetic transport only: production never substitutes an IP.
      Object.defineProperty(socket, 'remoteAddress', { value: host });
      return socket;
    };
    await withProxy({ resolver: async () => [{ address: '8.8.8.8' }], dial }, async ({ port }) => {
      const response = await raw(port, httpRequest('http://public.test/path?q=1', 'public.test'));
      assert.match(response, /^HTTP\/1\.1 302/);
      assert.deepEqual(seen, { host: 'public.test', url: '/path?q=1' });
      assert.match(await raw(port, httpRequest('http://127.0.0.1/denied', '127.0.0.1')), /^HTTP\/1\.1 403/);
    });
  } finally { await new Promise((resolve) => upstream.close(resolve)); }
});

test('CONNECT forwards unchanged TLS ClientHello for matching SNI but drops mismatched SNI', async () => {
  const frames = [];
  const upstream = net.createServer((socket) => socket.on('data', (data) => { frames.push(data); socket.end(); }));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const hello = (name) => {
    const hostname = Buffer.from(name);
    const names = Buffer.concat([Buffer.from([0, 0, hostname.length]), hostname]);
    const sni = Buffer.concat([Buffer.from([0, names.length]), names]);
    const ext = Buffer.concat([Buffer.from([0, 0, 0, sni.length]), sni]);
    const extensions = Buffer.concat([Buffer.from([0, ext.length]), ext]);
    const payload = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0, 0x2f, 1, 0]), extensions]);
    const handshake = Buffer.concat([Buffer.from([1, 0, 0, payload.length]), payload]);
    return Buffer.concat([Buffer.from([22, 3, 1, 0, handshake.length]), handshake]);
  };
  const dial = ({ host }) => {
    assert.equal(host, '8.8.8.8');
    const socket = net.connect(upstream.address().port, '127.0.0.1');
    Object.defineProperty(socket, 'remoteAddress', { value: host });
    return socket;
  };
  async function tunnel(port, name) {
    return new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1');
      let response = '';
      client.setTimeout(3000, () => client.destroy(new Error('timeout')));
      client.on('connect', () => client.write(connectRequest('public.test:443')));
      client.on('data', (part) => {
        response += part.toString();
        if (response.startsWith('HTTP/1.1 200') && !client.sentHello) {
          client.sentHello = true;
          client.write(hello(name));
        }
      });
      client.on('close', () => resolve(response));
      client.on('error', reject);
    });
  }
  try {
    await withProxy({ resolver: async () => [{ address: '8.8.8.8' }], dial }, async ({ port }) => {
      await tunnel(port, 'wrong.test');
      assert.equal(frames.length, 0);
      await tunnel(port, Buffer.concat([Buffer.from([0xf0]), Buffer.from('ublic.test')]));
      assert.equal(frames.length, 0, 'high-bit SNI bytes must not alias the CONNECT host');
      await tunnel(port, 'public.test');
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0], hello('public.test'));
    });
  } finally { await new Promise((resolve) => upstream.close(resolve)); }
});
