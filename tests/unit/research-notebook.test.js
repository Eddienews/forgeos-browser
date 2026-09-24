'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../../src/engine/research-notebook');
function isolated(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-notebook-test-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = [
  { name: 'notebook is chrome-only, excluded from agent routes and packaged explicitly', fn: assert => {
    const root = path.join(__dirname, '../..');
    const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
    const panels = fs.readFileSync(path.join(root, 'src/renderer/panels.js'), 'utf8');
    const { PACKAGE_FILES } = require('../../scripts/package-policy');
    assert(PACKAGE_FILES.includes('src/engine/research-notebook.js'));
    assert(main.includes('fromChrome(e)') && main.includes('!t || t.agentOwned || t.closing'));
    assert(main.includes("app.getPath('userData') : getRuntimeBase()"));
    assert(preload.includes("ipcRenderer.invoke('forge:notebook-capture')"));
    assert(!fs.readFileSync(path.join(root, 'src/ext/agent-api.js'), 'utf8').includes('forge:notebook'));
    assert(panels.includes('quote.textContent = source.excerpt'));
    assert(panels.includes('title.textContent = source.title'));
    assert(!panels.includes('innerHTML = source.'));
  } },
  { name: 'atomic persistence, restart, multi-source comparison and exact references', fn: assert => isolated(root => {
    const a = N.addSource(root, { url: 'https://example.com/p?q=secret#top', title: 'A', excerpt: 'One finding' }).source;
    const b = N.addSource(root, { url: 'https://other.test/b', title: 'B', excerpt: 'Other finding' }).source;
    assert.equal(N.addSource(root, { url: 'https://example.com/p?different', title: 'A', excerpt: 'One finding' }).duplicate, true);
    N.saveNotes(root, 'Compare sources directly.');
    N.setComparison(root, [a.id, b.id]);
    delete require.cache[require.resolve('../../src/engine/research-notebook')];
    const restart = require('../../src/engine/research-notebook');
    const state = restart.load(root);
    assert.equal(state.sources.length, 2);
    assert.deepEqual(state.comparison, [a.id, b.id]);
    assert.equal(state.sources[0].url, 'https://example.com/p');
    const output = path.join(root, 'export.txt');
    const result = restart.exportTo(root, output);
    assert.equal(result.bytes, Buffer.byteLength(fs.readFileSync(output)));
    const exported = fs.readFileSync(output, 'utf8');
    assert(exported.includes('[1] A\nURL: https://example.com/p\nCaptured: '));
    assert(exported.includes('[2] B — https://other.test/b ('));
    assert(exported.includes('Compare sources directly.'));
    assert.throws(() => restart.exportTo(root, output), /EEXIST/);
    restart.removeSource(root, a.id);
    assert.deepEqual(restart.load(root).comparison, [b.id]);
  }) },
  { name: 'hostile title/excerpt/URL, limits and duplicate comparison rejected', fn: assert => isolated(root => {
    const input = { url: 'https://example.com/', title: '<img src=x onerror=alert(1)>', excerpt: '<script>alert(1)</script>' };
    const source = N.addSource(root, input).source;
    assert.equal(source.title, input.title);
    assert(N.exportText(N.load(root)).includes(input.excerpt));
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/authorization=Bearer%20abc', 'javascript:alert(1)'])
      assert.throws(() => N.addSource(root, { ...input, url }), /Invalid source URL/);
    assert.throws(() => N.addSource(root, { ...input, excerpt: 'password=fixtureValue' }), /Invalid excerpt/);
    assert.throws(() => N.addSource(root, { ...input, title: 'Authorization=Bearer abc' }), /Invalid title/);
    assert.throws(() => N.addSource(root, { ...input, excerpt: 'x'.repeat(N.MAX_EXCERPT + 1) }), /Invalid excerpt/);
    assert.throws(() => N.saveNotes(root, 'x'.repeat(12001)), /Invalid notes/);
    assert.throws(() => N.setComparison(root, [source.id, source.id]), /Invalid comparison/);
    assert.throws(() => N.setComparison(root, ['unknown']), /Invalid comparison/);
    assert.equal(N.load(root).sources.length, 1);
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  }) },
];
