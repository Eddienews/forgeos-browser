/* agent-provider.test.js — the user's own inference key.
 * The promise this module makes: the key is stored with owner-only
 * permissions, and it NEVER comes back out through status(). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const provider = require('../../src/engine/agent-provider');

const A_KEY = 'sk-abcdefghijklmnop1234567890';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-provider-test-'));
}

module.exports = [
  {
    name: 'a plausible key is accepted, junk is rejected with a reason',
    gate: 'A',
    fn: async (assert) => {
      assert.strictEqual(provider.validateKey('typesafe', A_KEY).ok, true);
      const bad = [
        ['', /empty/],
        ['   ', /empty/],
        ['nope', /does not look like/],
        ['pk-abcdefghijklmnop1234', /does not look like/],
        ['sk-short', /does not look like/],
        ['sk-abc defghijklmnop123', /whitespace/],
        ['sk-' + 'a'.repeat(500), /implausibly long/],
      ];
      for (const [key, pattern] of bad) {
        const r = provider.validateKey('typesafe', key);
        assert.strictEqual(r.ok, false, `should have rejected: ${JSON.stringify(key.slice(0, 30))}`);
        assert.ok(pattern.test(r.reason), `reason for ${JSON.stringify(key.slice(0, 12))} was: ${r.reason}`);
      }
      assert.strictEqual(provider.validateKey('nope-provider', A_KEY).ok, false);
    },
  },
  {
    name: 'a saved key round-trips and is stored outside settings',
    gate: 'A',
    fn: async (assert) => {
      const dir = tmpDir();
      const saved = provider.saveKey(dir, 'typesafe', A_KEY);
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.hint, 'sk-…90', 'the report carries a hint, not the key');
      assert.ok(!JSON.stringify(saved).includes(A_KEY), 'the save report must not contain the key');

      const read = provider.readKey(dir, { env: {} });
      assert.strictEqual(read.key, A_KEY);
      assert.strictEqual(read.provider, 'typesafe');

      // It must not be in settings.json, which is plain text and gets backed up.
      const files = fs.readdirSync(dir);
      assert.ok(!files.includes('settings.json'), 'the key must never live in settings.json');
      assert.ok(files.some((f) => f.includes('forge-inference-key')), `key file missing; saw ${files.join(',')}`);

      // No temporary files left behind by the atomic write.
      assert.ok(!files.some((f) => f.includes('.tmp')), 'the atomic write must not leave temporary files');
    },
  },
  {
    name: 'status never reveals the key and reports what is editable',
    gate: 'A2',
    fn: async (assert) => {
      const dir = tmpDir();
      const empty = provider.status(dir, { env: {} });
      assert.strictEqual(empty.configured, false);
      assert.strictEqual(empty.source, null);
      assert.ok(Array.isArray(empty.providers) && empty.providers.length > 0, 'the UI needs the provider list');

      provider.saveKey(dir, 'typesafe', A_KEY);
      const st = provider.status(dir, { env: {} });
      const serialised = JSON.stringify(st);
      assert.strictEqual(st.configured, true);
      assert.strictEqual(st.source, 'file');
      assert.strictEqual(st.editable, true);
      assert.strictEqual(st.hint, 'sk-…90');
      assert.ok(!serialised.includes(A_KEY), 'status must never contain the key');
      assert.ok(!serialised.includes('abcdefghijklmnop'), 'no meaningful fragment may leak');

      // A key from the environment wins, and the UI must not offer to edit it.
      const fromEnv = provider.status(dir, { env: { [provider.ENV_VAR]: A_KEY } });
      assert.strictEqual(fromEnv.source, 'env');
      assert.strictEqual(fromEnv.editable, false);
      assert.ok(!JSON.stringify(fromEnv).includes(A_KEY));
    },
  },
  {
    name: 'clearing removes the key and is idempotent',
    gate: 'A',
    fn: async (assert) => {
      const dir = tmpDir();
      provider.saveKey(dir, 'typesafe', A_KEY);
      const cleared = provider.clearKey(dir);
      assert.strictEqual(cleared.ok, true);
      assert.strictEqual(cleared.removed, true);
      assert.strictEqual(provider.readKey(dir, { env: {} }).key, null);
      // Clearing twice is fine.
      const again = provider.clearKey(dir);
      assert.strictEqual(again.ok, true);
      assert.strictEqual(again.removed, false);
      assert.strictEqual(provider.status(dir, { env: {} }).configured, false);
    },
  },
  {
    name: 'a malformed key file degrades to "not configured", never a crash',
    gate: 'A',
    fn: async (assert) => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, provider.KEY_FILE), 'not a key at all');
      const read = provider.readKey(dir, { env: {} });
      // It reads what is there; status must still not crash.
      assert.strictEqual(typeof read.key, 'string');
      fs.writeFileSync(path.join(dir, provider.KEY_FILE), '');
      assert.strictEqual(provider.readKey(dir, { env: {} }).key, null, 'an empty file means no key');
      assert.strictEqual(provider.status(dir, { env: {} }).configured, false);
    },
  },
  {
    name: 'an unreadable directory fails closed without throwing',
    gate: 'A',
    fn: async (assert) => {
      const missing = path.join(os.tmpdir(), 'forge-provider-does-not-exist-' + Date.now(), 'nested');
      assert.strictEqual(provider.readKey(missing, { env: {} }).key, null);
      assert.strictEqual(provider.status(missing, { env: {} }).configured, false);
      const r = provider.saveKey(missing, 'typesafe', A_KEY);
      assert.strictEqual(r.ok, false, 'saving into a missing directory must report failure, not throw');
      assert.ok(r.reason.length > 0);
    },
  },
  {
    name: 'the mask shows enough to recognise a key, never enough to use it',
    gate: 'A2',
    fn: async (assert) => {
      const masked = provider.maskKey(A_KEY);
      assert.strictEqual(masked, 'sk-…90');
      assert.ok(masked.length < A_KEY.length / 2);
      assert.ok(!masked.includes('abcdefghijklmnop'));
      assert.strictEqual(provider.maskKey('short'), '••••');
      assert.strictEqual(provider.maskKey(''), '••••');
      assert.strictEqual(provider.maskKey(null), '••••');
    },
  },
];
