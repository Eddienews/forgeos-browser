'use strict';
const { matchesCredentialHost } = require('../../src/engine/credential-policy');

module.exports = [
  {
    name: 'path-qualified identity login URLs match full path segments',
    gate: 'A2',
    fn: (assert) => {
      for (const url of [
        'https://facebook.com/login', 'https://www.facebook.com/login/',
        'https://x.com/i/flow/login', 'https://twitter.com/i/flow/signup',
        'https://linkedin.com/uas/login',
      ]) assert.strictEqual(matchesCredentialHost(url), true, url);
      assert.strictEqual(matchesCredentialHost('https://accounts.google.com/signin'), true);
    },
  },
  {
    name: 'path-qualified match respects host and segment boundaries',
    gate: 'A2',
    fn: (assert) => {
      for (const url of [
        'https://facebook.com/login-evil', 'https://facebook.com/not-login',
        'https://x.com/i/flowing/login', 'https://x.com/i/other',
        'https://fakefacebook.com/login', 'https://x.com.evil.test/i/flow/login',
        'not a url',
      ]) assert.strictEqual(matchesCredentialHost(url), false, url);
    },
  },
];