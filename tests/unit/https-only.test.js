'use strict';

/* Gate K — HTTPS-only: upgrade plain HTTP, never downgrade without the human. */
const fs = require('fs');
const path = require('path');
const { httpsUpgradeTarget, isLocalHost, createHttpsOnlyState } = require('../../src/engine/https-only');

const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/\r\n/g, '\n');

module.exports = [
  {
    name: 'plain-HTTP navigations to public hosts are retried over HTTPS',
    gate: 'K',
    fn(a) {
      a.strictEqual(httpsUpgradeTarget('http://site.test.example.org/a?b=1#c'), 'https://site.test.example.org/a?b=1#c');
      a.strictEqual(httpsUpgradeTarget('http://Example.COM/'), 'https://example.com/');
      a.strictEqual(httpsUpgradeTarget('http://example.com:8080/x'), 'https://example.com:8080/x', 'the port is kept');
      a.strictEqual(httpsUpgradeTarget('http://8.8.8.8/'), 'https://8.8.8.8/');
      for (const url of ['https://example.com/', 'file:///etc/passwd', 'about:blank', 'data:text/html,x', 'ftp://example.com/', '', null, 'not a url'])
        a.strictEqual(httpsUpgradeTarget(url), null, String(url));
      a.strictEqual(httpsUpgradeTarget('http://example.com/', { enabled: false }), null);
    },
  },
  {
    name: 'local hosts that cannot hold a public certificate are left alone',
    gate: 'K',
    fn(a) {
      for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '10.0.0.5', '192.168.1.1', '172.16.0.1',
        '169.254.169.254', '[::1]', '[fe80::1]', '[fd00::1]', 'router', 'nas.local', 'printer.lan', 'svc.internal',
        'box.home.arpa', 'dev.test', 'LOCALHOST', 'localhost.'])
        a.strictEqual(isLocalHost(host), true, host);
      for (const host of ['example.com', 'localhost.example.com', 'local', '8.8.8.8', '172.32.0.1', '[2606:4700::1]', 'test.com', 'my-lan.org'])
        a.strictEqual(isLocalHost(host), host === 'local', host);
      a.strictEqual(httpsUpgradeTarget('http://localhost:3000/'), null);
      a.strictEqual(httpsUpgradeTarget('http://192.168.1.1/admin'), null);
      a.strictEqual(httpsUpgradeTarget('http://nas.local/'), null);
    },
  },
  {
    name: 'a host is served over HTTP only after the human allowed that exact host',
    gate: 'K',
    fn(a) {
      const state = createHttpsOnlyState();
      const options = { allowedHosts: state.allowedHosts };
      a.strictEqual(httpsUpgradeTarget('http://old.example.com/', options), 'https://old.example.com/');
      state.allowHttp('OLD.example.com');
      a.strictEqual(httpsUpgradeTarget('http://old.example.com/page', options), null);
      a.strictEqual(httpsUpgradeTarget('http://other.example.com/', options), 'https://other.example.com/');
      a.strictEqual(httpsUpgradeTarget('http://sub.old.example.com/', options), 'https://sub.old.example.com/', 'no subdomain inheritance');
      state.clear();
      a.strictEqual(httpsUpgradeTarget('http://old.example.com/', options), 'https://old.example.com/');
    },
  },
  {
    name: 'a fallback is offered only for the failed secure retry of that host, once',
    gate: 'K',
    fn(a) {
      let clock = 1000;
      const state = createHttpsOnlyState({ now: () => clock, ttlMs: 5000 });
      state.noteUpgrade('http://old.example.com/a', 'https://old.example.com/a');
      a.strictEqual(state.takeFailedUpgrade('https://evil.example.net/'), null, 'another host');
      a.strictEqual(state.takeFailedUpgrade('http://old.example.com/a'), null, 'a failed HTTP load is not a failed upgrade');
      const taken = state.takeFailedUpgrade('https://old.example.com/other-path');
      a.deepStrictEqual({ host: taken.host, httpUrl: taken.httpUrl }, { host: 'old.example.com', httpUrl: 'http://old.example.com/a' });
      a.strictEqual(state.takeFailedUpgrade('https://old.example.com/a'), null, 'consumed once');

      state.noteUpgrade('http://old.example.com/a', 'https://old.example.com/a');
      state.settle('https://old.example.com/a');
      a.strictEqual(state.takeFailedUpgrade('https://old.example.com/a'), null, 'a secure load ends it');

      state.noteUpgrade('http://old.example.com/a', 'https://old.example.com/a');
      state.settle('http://old.example.com/a');
      a.ok(state.takeFailedUpgrade('https://old.example.com/a'), 'an insecure load does not end it');

      state.noteUpgrade('http://old.example.com/a', 'https://old.example.com/a');
      clock += 6000;
      a.strictEqual(state.takeFailedUpgrade('https://old.example.com/a'), null, 'stale upgrades expire');
      state.noteUpgrade('https://already.example.com/', 'https://already.example.com/');
      a.strictEqual(state.takeFailedUpgrade('https://already.example.com/'), null, 'only http:// navigations are recorded');
    },
  },
  {
    name: 'the downgrade is a native human decision, never offered to an agent tab, and on by default',
    gate: 'K',
    fn(a) {
      const main = read('src/main.js');
      const start = main.indexOf('async function offerHttpFallback(tab, failedUrl, reason) {');
      const body = main.slice(start, main.indexOf('async function refreshAgentView(tab) {', start));
      a.ok(start > 0);
      const refuse = body.indexOf('if (tab.agentOwned || tab.closing || activeTabId !== tab.id');
      const ask = body.indexOf('dialog.showMessageBox(chromeWin');
      const allow = body.indexOf('tab.adapter.httpsOnly.allowHttp(upgrade.host)');
      a.ok(refuse > 0 && ask > refuse && allow > ask, 'refusals, then the dialog, then the allowance');
      a.match(body, /buttons: \['Stay secure', 'Continue over HTTP'\],\s+defaultId: 0, cancelId: 0/);
      a.match(body, /if \(!allowed \|\| tab\.closing/);
      a.strictEqual(require('../../src/engine/settings').DEFAULTS.httpsOnly, true);
      const adapter = read('src/ext/electron-adapter.js');
      // The upgrade happens before tracking-parameter cleanup and before any request leaves.
      a.ok(adapter.indexOf('httpsUpgradeTarget(url, {') < adapter.indexOf('const cleaned = cleanUrl(url);'));
      a.match(adapter, /if \(resourceType === 'mainFrame' && S\.httpsOnly !== false\)/);
      a.match(main, /adapter\.httpsOnly\.clear\(\);/);
      const { PACKAGE_FILES } = require('../../scripts/package-policy');
      a.ok(PACKAGE_FILES.includes('src/engine/https-only.js'));
    },
  },
  {
    name: 'printing and saving a PDF act on the page the human is looking at',
    gate: 'K',
    fn(a) {
      const { shortcutAction } = require('../../src/engine/desktop-integration');
      a.strictEqual(shortcutAction({ type: 'keyDown', key: 'p', control: true }), 'print');
      a.strictEqual(shortcutAction({ type: 'keyDown', key: 'p' }), null);
      const output = read('src/main/page-output.js');
      const start = output.indexOf('async function savePageAsPdf() {');
      const body = output.slice(start, output.indexOf('return { printActiveTab, savePageAsPdf };', start));
      a.ok(start > 0 && body.length > 200);
      a.match(body, /dialog\.showSaveDialog\(ctx\.chromeWin/);
      a.match(body, /path\.extname\(choice\.filePath\)\.toLowerCase\(\) !== '\.pdf'/);
      // Re-checked after the dialog: the saved page is the one that was shown.
      a.ok(body.indexOf('t.wc.getURL() !== url') > body.indexOf('dialog.showSaveDialog'));
      a.match(body, /ctx\.activeTabId !== id/);
      a.ok(body.indexOf('printToPDF') > body.indexOf('t.wc.getURL() !== url'));
    },
  },
];
