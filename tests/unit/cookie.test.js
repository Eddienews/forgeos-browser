'use strict';

/* Gate D — Phase 4: cookie policy. Mission Tests B & C. */
const {
  parseSetCookie, decideSetCookie, filterSetCookieHeaders, decideExistingCookie,
} = require('../../src/engine/cookie-policy');

module.exports = [
  {
    name: 'Test B — first-party session cookie ALLOWED',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: 'session=abc123; Path=/',
        requestOrigin: 'https://example.com',
        tabUrl: 'https://example.com',
        modeId: 'standard',
      });
      a.strictEqual(r.decision, 'ALLOW');
      a.strictEqual(r.reason, 'first-party cookie');
    },
  },
  {
    name: 'first-party persistent cookie ALLOWED in standard mode',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: 'pref=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
        requestOrigin: 'https://example.com',
        tabUrl: 'https://example.com',
        modeId: 'standard',
      });
      a.strictEqual(r.decision, 'ALLOW');
      a.strictEqual(r.cookie.isPersistent, true);
    },
  },
  {
    name: 'Test C — third-party cookie BLOCKED',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: 'uid=tracker123; Max-Age=3600; Path=/',
        requestOrigin: 'https://doubleclick.net',
        tabUrl: 'https://example.com',
        modeId: 'standard',
      });
      a.strictEqual(r.decision, 'BLOCK');
      a.strictEqual(r.reason, 'third-party cookie');
    },
  },
  {
    name: 'known tracking cookie blocked EVEN first-party (_ga)',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: '_ga=GA1.1.1234567.8901234; Path=/',
        requestOrigin: 'https://example.com',
        tabUrl: 'https://example.com',
        modeId: 'standard',
      });
      a.strictEqual(r.decision, 'BLOCK');
      a.strictEqual(r.reason, 'known tracking cookie');
    },
  },
  {
    name: 'tracking cookie prefix rule (_ga_*)',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: '_ga_ABC123=GS1.1.1.1; Path=/',
        requestOrigin: 'https://example.com',
        tabUrl: 'https://example.com',
        modeId: 'standard',
      });
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'strict mode blocks persistent first-party cookies, keeps session ones',
    gate: 'D',
    fn(a) {
      const persistent = decideSetCookie({
        setCookieHeader: 'pref=dark; Max-Age=31536000; Path=/',
        requestOrigin: 'https://example.com', tabUrl: 'https://example.com', modeId: 'strict',
      });
      a.strictEqual(persistent.decision, 'BLOCK');
      a.strictEqual(persistent.reason, 'persistent cookie blocked by mode');
      const session = decideSetCookie({
        setCookieHeader: 'session=abc; Path=/', requestOrigin: 'https://example.com', tabUrl: 'https://example.com', modeId: 'strict',
      });
      a.strictEqual(session.decision, 'ALLOW');
    },
  },
  {
    name: 'ephemeral blocks persistent cookies too',
    gate: 'D',
    fn(a) {
      const r = decideSetCookie({
        setCookieHeader: 'pref=dark; Expires=Fri, 01 Jan 2038 00:00:00 GMT; Path=/',
        requestOrigin: 'https://example.com', tabUrl: 'https://example.com', modeId: 'ephemeral',
      });
      a.strictEqual(r.decision, 'BLOCK');
    },
  },
  {
    name: 'parseSetCookie: persistence/preferences extracted',
    gate: 'D',
    fn(a) {
      const c = parseSetCookie('ssid=xyz; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900');
      a.strictEqual(c.name, 'ssid');
      a.strictEqual(c.isPersistent, true);
      a.strictEqual(c.isSecure, true);
      a.strictEqual(c.httpOnly, true);
      a.strictEqual(c.sameSite, 'lax');
    },
  },
  {
    name: 'filterSetCookieHeaders strips disallowed cookies, keeps allowed',
    gate: 'D',
    fn(a) {
      // Request from a third-party host: everything disallowed.
      const third = filterSetCookieHeaders({
        'content-type': ['text/html'],
        'set-cookie': ['session=ok; Path=/', 'partner=no; Max-Age=3600', '_ga=GA1.1.9; Path=/'],
      }, { requestUrl: 'https://doubleclick.net', tabUrl: 'https://example.com', modeId: 'standard' });
      a.strictEqual(third.blocked.length, 3);
      a.strictEqual(third.headers['set-cookie'], undefined);
      // First-party response: session cookie survives, tracker stripped.
      const first = filterSetCookieHeaders({
        'set-cookie': ['session=ok; Path=/', '_ga=GA1.1.9; Path=/'],
      }, { requestUrl: 'https://example.com', tabUrl: 'https://example.com', modeId: 'standard' });
      a.strictEqual(first.blocked.length, 1);
      a.deepStrictEqual(first.headers['set-cookie'], ['session=ok; Path=/']);
    },
  },
  {
    name: 'decideExistingCookie (jar re-check) matches policy',
    gate: 'D',
    fn(a) {
      a.strictEqual(decideExistingCookie({ name: '_gid', domain: '.example.com', session: false }, { modeId: 'standard', tabHost: 'example.com' }).decision, 'BLOCK');
      a.strictEqual(decideExistingCookie({ name: 'pref', domain: '.example.com', session: true }, { modeId: 'standard', tabHost: 'example.com' }).decision, 'ALLOW');
      a.strictEqual(decideExistingCookie({ name: 'pref', domain: '.other.com', session: true }, { modeId: 'standard', tabHost: 'example.com' }).decision, 'BLOCK');
    },
  },
];