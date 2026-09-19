/* url-safety.test.js — SSRF defense for agent-supplied URLs.
 * The vector: a model-chosen URL (possibly prompt-injected) pointed at an
 * internal service or a cloud metadata endpoint, whose response the agent can
 * then read back through the API. Every case below must fail closed. */
'use strict';
const safety = require('../../src/engine/url-safety');

/** Fake resolver: hostname → addresses. */
const fakeDns = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const allows = async (url, opts = {}) => {
  try { await safety.ensureNavigable(url, opts); return true; } catch { return false; }
};

module.exports = [
  {
    name: 'cloud metadata endpoint is refused (169.254.169.254)',
    gate: 'A2',
    fn: async () => {
      const url = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
      if (await allows(url, { resolver: fakeDns({}) })) throw new Error('metadata endpoint was reachable');
      // Also via hostname that resolves there.
      if (await allows('http://metadata.google.internal/', { resolver: fakeDns({ 'metadata.google.internal': ['169.254.169.254'] }) })) {
        throw new Error('metadata hostname was reachable');
      }
    },
  },
  {
    name: 'loopback is refused by default',
    gate: 'A2',
    fn: async () => {
      for (const url of ['http://127.0.0.1:8080/admin', 'http://[::1]:9000/', 'http://localhost/']) {
        if (await allows(url, { resolver: fakeDns({ localhost: ['127.0.0.1'] }) })) {
          throw new Error(`loopback reachable: ${url}`);
        }
      }
    },
  },
  {
    name: 'private RFC1918 ranges are refused',
    gate: 'A2',
    fn: async () => {
      const cases = [
        ['http://192.168.1.1/admin', ['192.168.1.1']],
        ['http://10.0.0.5/', ['10.0.0.5']],
        ['http://172.16.4.4/', ['172.16.4.4']],
        ['http://router.local/', ['192.168.0.1']],
      ];
      for (const [url, addrs] of cases) {
        const host = new URL(url).hostname;
        if (await allows(url, { resolver: fakeDns({ [host]: addrs }) })) {
          throw new Error(`private address reachable: ${url}`);
        }
      }
    },
  },
  {
    name: 'a hostname resolving to BOTH public and private is refused',
    gate: 'A2',
    fn: async () => {
      const url = 'http://mixed.example/';
      const resolver = fakeDns({ 'mixed.example': ['93.184.216.34', '10.1.2.3'] });
      if (await allows(url, { resolver })) throw new Error('mixed-resolution host leaked a private address');
    },
  },
  {
    name: 'public https URLs still work',
    gate: 'A2',
    fn: async () => {
      const resolver = fakeDns({ 'example.com': ['93.184.216.34'] });
      if (!(await allows('https://example.com/page', { resolver }))) {
        throw new Error('a normal public URL was refused');
      }
      // A literal public IP needs no DNS at all.
      if (!(await allows('https://93.184.216.34/', { resolver: fakeDns({}) }))) {
        throw new Error('literal public IP was refused');
      }
    },
  },
  {
    name: 'non-http schemes and malformed URLs are refused',
    gate: 'A2',
    fn: async () => {
      const resolver = fakeDns({ 'example.com': ['93.184.216.34'] });
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/', 'not a url']) {
        if (await allows(url, { resolver })) throw new Error(`unsafe scheme accepted: ${url}`);
      }
      // Unresolvable hostname fails closed.
      if (await allows('http://does-not-resolve.example/', { resolver: fakeDns({}) })) {
        throw new Error('unresolvable host accepted');
      }
    },
  },
  {
    name: 'allowPrivate permits loopback but NEVER link-local / metadata',
    gate: 'A2',
    fn: async () => {
      const resolver = fakeDns({ 'dev.local': ['127.0.0.1'], 'meta.local': ['169.254.169.254'] });
      if (!(await allows('http://dev.local:3000/', { resolver, allowPrivate: true }))) {
        throw new Error('allowPrivate did not permit a local dev server');
      }
      if (await allows('http://meta.local/', { resolver, allowPrivate: true })) {
        throw new Error('allowPrivate wrongly permitted the metadata endpoint');
      }
    },
  },
];
