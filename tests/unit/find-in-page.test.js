'use strict';

const { FindInPage } = require('../../src/engine/find-in-page');
const { isPackageExcluded } = require('../../scripts/package-policy');

function fixture() {
  const calls = [];
  const events = [];
  let nextId = 0;
  const wc = {
    isDestroyed: () => false,
    findInPage: (query, options) => { calls.push(['find', query, options]); return ++nextId; },
    stopFindInPage: (mode) => calls.push(['stop', mode]),
  };
  const tab = { wc, id: 1 };
  const other = { wc: { ...wc }, id: 2 };
  const find = new FindInPage((event) => events.push(event));
  return { calls, events, tab, other, find };
}

module.exports = [
  { name: 'native find advances in both directions and ignores stale results', gate: 'FIND', fn(assert) {
    const { calls, events, tab, find } = fixture();
    assert.strictEqual(find.open(tab), true);
    assert.strictEqual(find.search(tab, 'amber'), true);
    find.result(tab, { requestId: 1, matches: 3, activeMatchOrdinal: 1 });
    assert.deepStrictEqual(events.at(-1), { open: true, matches: 3, active: 1 });
    const updates = events.length;
    assert.strictEqual(find.open(tab), true);
    assert.strictEqual(events.length, updates, 'reopening does not reset current index');
    assert.strictEqual(find.search(tab, 'amber', 'backward'), true);
    assert.deepStrictEqual(calls.at(-1), ['find', 'amber', { forward: false, findNext: false }]);
    find.result(tab, { requestId: 1, matches: 3, activeMatchOrdinal: 1 });
    assert.deepStrictEqual(events.at(-1), { open: true, matches: 0, active: 0 });
    find.result(tab, { requestId: 2, matches: 3, activeMatchOrdinal: 3 });
    assert.deepStrictEqual(events.at(-1), { open: true, matches: 3, active: 3 });
    find.search(tab, 'walnut');
    assert.deepStrictEqual(calls.at(-1), ['find', 'walnut', { forward: true, findNext: true }]);
  } },
  { name: 'tab change and close clear native selection without cross-tab leakage', gate: 'FIND', fn(assert) {
    const { calls, events, tab, other, find } = fixture();
    find.open(tab); find.search(tab, 'private');
    assert.strictEqual(find.search(other, 'private'), false);
    find.open(other);
    assert.deepStrictEqual(calls.at(-1), ['stop', 'clearSelection']);
    assert.strictEqual(find.query, '');
    find.close();
    assert.deepStrictEqual(events.at(-1), { open: false, matches: 0, active: 0 });
    find.result(tab, { requestId: 1, matches: 2, activeMatchOrdinal: 1 });
    assert.deepStrictEqual(events.at(-1), { open: false, matches: 0, active: 0 });
  } },
  { name: 'invalid query and direction rejected; empty query clears selection', gate: 'FIND', fn(assert) {
    const { calls, tab, find } = fixture();
    find.open(tab);
    assert.strictEqual(find.search(tab, null), false);
    assert.strictEqual(find.search(tab, 'x'.repeat(513)), false);
    assert.strictEqual(find.search(tab, 'test', 'sideways'), false);
    assert.strictEqual(calls.length, 0);
    find.search(tab, 'test'); find.search(tab, '');
    assert.strictEqual(find.query, '');
    assert.deepStrictEqual(calls.at(-1), ['stop', 'clearSelection']);
  } },
  { name: 'packager explicitly includes runtime search engine', gate: 'FIND', fn(assert) {
    assert.strictEqual(isPackageExcluded('src/engine/find-in-page.js'), false);
    assert.strictEqual(isPackageExcluded('src/engine/find-in-page.js.bak'), true);
  } },
];
