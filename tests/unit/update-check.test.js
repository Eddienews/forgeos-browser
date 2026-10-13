'use strict';

/* Gate K — the update notice: what it sends, what it trusts, what it may open. */
const fs = require('fs');
const path = require('path');
const { FEED_URL, REPOSITORY, parseVersion, assessRelease, releasePageUrl, checkForUpdate } =
  require('../../src/engine/update-check');

const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/\r\n/g, '\n');
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

module.exports = [
  {
    name: 'only a strict three-part version is accepted from a release',
    gate: 'K',
    fn(a) {
      a.deepStrictEqual(parseVersion('v0.17.0'), [0, 17, 0]);
      a.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3]);
      for (const bad of ['', 'v1.2', '1.2.3.4', '1.2.3-beta', 'v1.2.3 ', ' 1.2.3\n<script>', 'latest', '1.2.x', '99999.1.1',
        'v1.2.3/../../evil', null, undefined, {}, 12])
        a.strictEqual(parseVersion(bad) && bad !== 'v1.2.3 ' ? 'accepted' : null, null, String(bad));
      a.deepStrictEqual(parseVersion('v1.2.3 '), [1, 2, 3], 'surrounding whitespace is trimmed');
    },
  },
  {
    name: 'a release is an update only when its version is strictly newer',
    gate: 'K',
    fn(a) {
      a.deepStrictEqual(assessRelease('0.16.0', { tag_name: 'v0.17.0' }),
        { available: true, latest: '0.17.0', url: `https://github.com/${REPOSITORY}/releases/tag/v0.17.0` });
      a.strictEqual(assessRelease('0.16.0', { tag_name: 'v0.16.0' }).available, false);
      a.strictEqual(assessRelease('0.16.0', { tag_name: 'v0.15.9' }).available, false);
      a.strictEqual(assessRelease('0.9.0', { tag_name: 'v0.10.0' }).available, true, 'numeric, not text, comparison');
      a.strictEqual(assessRelease('0.16.0', { tag_name: 'v1.0.0', prerelease: true }).available, false);
      a.strictEqual(assessRelease('0.16.0', { tag_name: 'v1.0.0', draft: true }).available, false);
      for (const bad of [null, 'v1.0.0', [], { tag_name: 'nope' }, { tag_name: 'v1.0.0-rc1' }, {}])
        a.strictEqual(assessRelease('0.16.0', bad).available, false);
      a.strictEqual(assessRelease('dev', { tag_name: 'v1.0.0' }).available, false);
    },
  },
  {
    name: 'the page offered is always this project\'s own release page, never a URL from the response',
    gate: 'K',
    fn(a) {
      const hostile = { tag_name: 'v9.9.9', html_url: 'https://evil.test/malware', assets: [{ browser_download_url: 'https://evil.test/x.exe' }] };
      const result = assessRelease('0.16.0', hostile);
      a.strictEqual(result.url, `https://github.com/${REPOSITORY}/releases/tag/v9.9.9`);
      a.doesNotMatch(JSON.stringify(result), /evil/);
      a.strictEqual(releasePageUrl('v1.2.3"><script>'), null);
      a.strictEqual(releasePageUrl('../../x'), null);
      const notice = read('src/main/update-notice.js');
      a.match(notice, /const url = updateStatus\.available \? updateCheck\.releasePageUrl\(updateStatus\.latest\) : null;/);
      a.doesNotMatch(notice + read('src/main.js'), /html_url|browser_download_url/);
    },
  },
  {
    name: 'the request carries no identifier and goes only to the fixed feed',
    gate: 'K',
    async fn(a) {
      const calls = [];
      const result = await checkForUpdate({ currentVersion: '0.16.0', now: () => new Date('2026-10-12T00:00:00Z'),
        fetchImpl: async (url, options) => { calls.push([url, options]); return reply(200, { tag_name: 'v0.17.0' }); } });
      a.deepStrictEqual(result, { ok: true, available: true, latest: '0.17.0',
        url: `https://github.com/${REPOSITORY}/releases/tag/v0.17.0`, checkedAt: '2026-10-12T00:00:00.000Z' });
      a.strictEqual(calls.length, 1);
      const [url, options] = calls[0];
      a.strictEqual(url, FEED_URL);
      a.strictEqual(url, `https://api.github.com/repos/${REPOSITORY}/releases/latest`);
      a.strictEqual(options.method, 'GET');
      a.strictEqual(options.credentials, 'omit');
      a.strictEqual(options.redirect, 'error');
      a.strictEqual(options.body, undefined);
      a.deepStrictEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
      // Not even the running version is disclosed.
      a.doesNotMatch(JSON.stringify([url, options.headers]), /0\.16\.0|cookie|authorization|token/i);
    },
  },
  {
    name: 'failures and odd responses never report an update',
    gate: 'K',
    async fn(a) {
      const check = (fetchImpl) => checkForUpdate({ currentVersion: '0.16.0', fetchImpl });
      const network = await check(async () => { throw new Error('offline'); });
      a.deepStrictEqual([network.ok, network.available, network.error], [false, false, 'network']);
      const limited = await check(async () => reply(403, { message: 'rate limit' }));
      a.deepStrictEqual([limited.ok, limited.available, limited.error], [false, false, 'http 403']);
      const garbage = await check(async () => reply(200, '<html>captive portal</html>'));
      a.deepStrictEqual([garbage.ok, garbage.available], [false, false]);
      const huge = await check(async () => reply(200, 'x'.repeat(600 * 1024)));
      a.strictEqual(huge.ok, false);
      const noRelease = await check(async () => reply(404, { message: 'Not Found' }));
      a.deepStrictEqual([noRelease.ok, noRelease.available], [true, false], 'no published release is not an error');
      const none = await checkForUpdate({ currentVersion: '0.16.0', fetchImpl: null });
      a.strictEqual(none.ok, false);
    },
  },
  {
    name: 'automatic checks run only for installed builds, respect the setting, and install nothing',
    gate: 'K',
    fn(a) {
      const notice = read('src/main/update-notice.js');
      const main = read('src/main.js');
      a.match(notice, /function scheduleUpdateChecks\(\) \{\s+if \(updateTimer \|\| !ctx\.isPackaged \|\| ctx\.isSmoke\) return;/);
      a.match(main, /isPackaged: IS_PACKAGED,\s+isSmoke: !!SMOKE_RUNTIME_BASE,/);
      a.match(notice, /if \(!manual && settings\.all\(\)\.checkForUpdates === false\) return publicUpdateStatus\(\);/);
      a.strictEqual(require('../../src/engine/settings').DEFAULTS.checkForUpdates, true);
      const engine = read('src/engine/update-check.js');
      // A notice only: no download, no write, no process, no shell.
      a.doesNotMatch(engine + notice,
        /child_process|spawn|(?<!\.)exec\(|execFile|writeFile|createWriteStream|shell\.open|autoUpdater/);
      const { PACKAGE_FILES } = require('../../scripts/package-policy');
      a.ok(PACKAGE_FILES.includes('src/engine/update-check.js') && PACKAGE_FILES.includes('src/main/update-notice.js'));
      a.match(read('PRIVACY_MODEL.md'), /update check/i);
    },
  },
];
