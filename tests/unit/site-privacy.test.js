'use strict';
const { exactOrigin, siteSnapshot, clearOriginData } = require('../../src/engine/site-privacy');

function fixture(dedicated = false) {
  const calls = [], cookies = [{ name: 'private', domain: 'alpha.test', path: '/', secure: false, hostOnly: true },
    { name: 'shared', domain: '.alpha.test', path: '/', secure: false, hostOnly: false }];
  const session = { cookies: { get: async () => cookies, remove: async (url, name) => calls.push(['cookie', url, name]) },
    clearData: async options => calls.push(['clearData', options]) };
  const tab = { id: 1, partition: dedicated ? 'forge-tab-test' : null, agentOwned: false, wc: {
    session, isDestroyed: () => false, getURL: () => 'https://alpha.test/page' }, pageCounts: { ads: 2, trackers: 3 }, adapter: { counters: { ads: 5 } } };
  const other = { wc: { session, isDestroyed: () => false, getURL: () => 'https://beta.test/page' } };
  return { tab, other, session, calls };
}
module.exports = [
  { name: 'reject untrusted and opaque origins', fn: a => {
    for (const url of ['file:///tmp/a', 'data:text/html,x', 'about:blank', 'https://user:pass@alpha.test/',
      'https://alpha.test\n.evil.test']) a.strictEqual(exactOrigin(url), null);
    a.strictEqual(exactOrigin('https://alpha.test:8443/path?q=1'), 'https://alpha.test:8443');
  } },
  { name: 'status binds live human tab and distinguishes page/session counts', fn: a => {
    const { tab } = fixture();
    a.deepStrictEqual(siteSnapshot(tab, () => true, () => false, tab.adapter.counters).counts, { ads: 2, trackers: 3 });
    a.strictEqual(siteSnapshot(tab, () => false, () => false, tab.adapter.counters).sessionCounts.ads, 5);
    tab.agentOwned = true;
    a.strictEqual(siteSnapshot(tab, () => true, () => true, {}), null);
    tab.agentOwned = false;
    tab.blockedCredentialUrl = 'https://accounts.example.test/login';
    tab.blockedCredentialNoticeUrl = 'data:text/html,internal-notice';
    tab.wc.getURL = () => tab.blockedCredentialNoticeUrl;
    a.strictEqual(siteSnapshot(tab, () => false, () => true, {}).origin, 'https://accounts.example.test');
    tab.wc.getURL = () => 'data:text/html,untrusted';
    a.strictEqual(siteSnapshot(tab, () => false, () => true, {}), null);
  } },
  { name: 'cancel and switch during approval do not clear anything', fn: async a => {
    const f = fixture();
    const run = confirm => clearOriginData({ ...f, current: () => f.tab, tabs: [f.tab], dedicated: true, confirm });
    a.strictEqual((await run(async () => false)).ok, false);
    a.strictEqual((await clearOriginData({ ...f, current: () => f.other, tabs: [f.tab], dedicated: true, confirm: async () => true })).ok, false);
    a.deepStrictEqual(f.calls, []);
  } },
  { name: 'shared default session preserves other origin cookies and cache', fn: async a => {
    const f = fixture();
    const r = await clearOriginData({ tab: f.tab, current: () => f.tab, tabs: [f.tab, f.other],
      session: f.session, dedicated: false, confirm: async () => true });
    a.strictEqual(r.ok, true);
    a.strictEqual(r.cacheCleared, false);
    a.strictEqual(r.cookiesRemoved, 0);
    a.deepStrictEqual(f.calls[0][1].origins, ['https://alpha.test']);
    a.strictEqual(f.calls[0][1].dataTypes.includes('cache'), false);
    a.strictEqual(f.calls.length, 1);
  } },
  { name: 'dedicated session clears scoped data and host-only cookie', fn: async a => {
    const f = fixture(true);
    const r = await clearOriginData({ tab: f.tab, current: () => f.tab, tabs: [f.tab], session: f.session,
      dedicated: true, confirm: async () => true });
    a.strictEqual(r.ok, true);
    a.strictEqual(r.cacheCleared, true);
    a.strictEqual(r.cookiesRemoved, 1);
    a.strictEqual(r.sharedCookiesSkipped, 1);
    a.strictEqual(f.calls[0][1].dataTypes.includes('cookies'), false);
    a.deepStrictEqual(f.calls[1], ['cookie', 'http://alpha.test/', 'private']);
  } },
  { name: 'other same-host origin prevents clearing', fn: async a => {
    const f = fixture(); f.other.wc.getURL = () => 'http://alpha.test/';
    const r = await clearOriginData({ tab: f.tab, current: () => f.tab, tabs: [f.tab, f.other],
      session: f.session, dedicated: false, confirm: async () => true });
    a.strictEqual(r.ok, false);
    a.deepStrictEqual(f.calls, []);
  } },
];
