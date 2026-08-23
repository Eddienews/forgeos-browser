'use strict';

/* Gate H — Phase 11/12: action approval gate + sensitive fields. Test F. */
const { requestAction } = require('../../src/engine/permissions');
const { classifyField, redactValue } = require('../../src/engine/sensitive-fields');

module.exports = [
  {
    name: 'read actions are ALLOW without approval',
    gate: 'H',
    fn(a) {
      for (const act of ['READ_PAGE', 'GET_AGENT_VIEW', 'GET_LINKS', 'SECURITY_STATUS']) {
        a.strictEqual(requestAction(act).verdict, 'ALLOW', act);
      }
    },
  },
  {
    name: 'NAVIGATE and OPEN_LINK are allowed (reading/navigation)',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('OPEN_LINK', { url: 'https://example.com/x' }).verdict, 'ALLOW');
      a.strictEqual(requestAction('NAVIGATE', { url: 'https://example.com/x' }).verdict, 'ALLOW');
    },
  },
  {
    name: 'Test F — UPLOAD_FILE requires approval',
    gate: 'H',
    fn(a) {
      const r = requestAction('UPLOAD_FILE', { filename: 'notes.txt' });
      a.strictEqual(r.verdict, 'ASK');
      a.ok(/approval/.test(r.reason));
    },
  },
  {
    name: 'SUBMIT_FORM requires approval',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('SUBMIT_FORM', { url: 'https://example.com/form' }).verdict, 'ASK');
    },
  },
  {
    name: 'SEND_MESSAGE / POST_COMMENT require approval',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('SEND_MESSAGE', {}).verdict, 'ASK');
      a.strictEqual(requestAction('POST_COMMENT', {}).verdict, 'ASK');
    },
  },
  {
    name: 'PURCHASE requires approval (spec: DENY/ASK)',
    gate: 'H',
    fn(a) {
      const r = requestAction('PURCHASE', { url: 'https://shop.example/checkout' });
      a.ok(r.verdict === 'ASK' || r.verdict === 'DENY', r.verdict);
    },
  },
  {
    name: 'DOWNLOAD_FILE requires approval; executables flagged',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('DOWNLOAD_FILE', { filename: 'paper.pdf' }).verdict, 'ASK');
      const exe = requestAction('DOWNLOAD_FILE', { filename: 'setup.exe' });
      a.strictEqual(exe.verdict, 'ASK');
      a.ok(/executable/.test(exe.reason));
    },
  },
  {
    name: 'ENTER_PASSWORD is HUMAN_ONLY — never automated',
    gate: 'H',
    fn(a) {
      const r = requestAction('ENTER_PASSWORD', {});
      a.strictEqual(r.verdict, 'HUMAN_ONLY');
    },
  },
  {
    name: 'form containing sensitive fields is HUMAN_ONLY, not just ASK',
    gate: 'H',
    fn(a) {
      const r = requestAction('SUBMIT_FORM', { containsSensitiveFields: true });
      a.strictEqual(r.verdict, 'HUMAN_ONLY');
    },
  },
  {
    name: 'DELETE_DATA / ACCESS_LOCAL_FILE require approval',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('DELETE_DATA', {}).verdict, 'ASK');
      a.strictEqual(requestAction('ACCESS_LOCAL_FILE', { path: 'C:/secret.txt' }).verdict, 'ASK');
    },
  },
  {
    name: 'click on a plain link is allowed; clicking a submit button asks',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('CLICK_ELEMENT', { tag: 'A', type: '', url: 'https://example.com' }).verdict, 'ALLOW');
      a.strictEqual(requestAction('CLICK_ELEMENT', { tag: 'INPUT', type: 'submit' }).verdict, 'ASK');
      a.strictEqual(requestAction('CLICK_ELEMENT', { tag: 'BUTTON', formAction: '/go' }).verdict, 'ASK');
      a.strictEqual(requestAction('CLICK_ELEMENT', { tag: 'INPUT', type: 'password', fieldSensitive: true }).verdict, 'HUMAN_ONLY');
    },
  },
  {
    name: 'unknown actions fail closed to ASK',
    gate: 'H',
    fn(a) {
      a.strictEqual(requestAction('DELETE_INSTALLED_APPLICATIONS', {}).verdict, 'ASK');
    },
  },
  {
    name: 'classifyField: type=password is sensitive',
    gate: 'G',
    fn(a) {
      a.strictEqual(classifyField({ type: 'password', name: 'pwd' }).sensitive, true);
    },
  },
  {
    name: 'classifyField: cc-number autocomplete + name hints',
    gate: 'G',
    fn(a) {
      a.strictEqual(classifyField({ type: 'text', name: 'cc_number', autocomplete: 'cc-number' }).sensitive, true);
      a.strictEqual(classifyField({ type: 'text', name: 'cvv' }).sensitive, true);
      a.strictEqual(classifyField({ type: 'text', name: 'api_key' }).sensitive, true);
      a.strictEqual(classifyField({ type: 'text', name: 'otp' }).sensitive, true);
    },
  },
  {
    name: 'classifyField: ordinary fields are not sensitive',
    gate: 'G',
    fn(a) {
      a.strictEqual(classifyField({ type: 'text', name: 'username' }).sensitive, false);
      a.strictEqual(classifyField({ type: 'email', name: 'email' }).sensitive, false);
    },
  },
  {
    name: 'redactValue redacts sensitive field values',
    gate: 'G',
    fn(a) {
      a.strictEqual(redactValue({ type: 'password', name: 'p' }, 'hunter2'), '<REDACTED>');
      a.strictEqual(redactValue({ type: 'text', name: 'note' }, 'plain'), 'plain');
    },
  },
];