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
    assert.equal(N.addSource(root, { url: 'https://example.com/p?q=secret#top', title: 'A', excerpt: 'One finding' }).duplicate, true);
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
    assert(exported.includes(`[1] A\nSource ID: ${a.id}\nBase URL (query/fragment not recorded): https://example.com/p\nSource fingerprint: ${a.sourceFingerprint}\nCaptured: `));
    assert(exported.includes(`[2] B — https://other.test/b [source ${b.id}; query/fragment not recorded] (`));
    assert(exported.includes('Compare sources directly.'));
    assert.throws(() => restart.exportTo(root, output), /EEXIST/);
    restart.removeSource(root, a.id);
    assert.deepEqual(restart.load(root).comparison, [b.id]);
  }) },
  { name: 'query-only document identity survives restart and export without leaking query', fn: assert => isolated(root => {
    const common = { title: 'Annual report', excerpt: 'Identical excerpt' };
    const firstUrl = 'https://example.com/report?id=2025&opaque=fixture-private-2025';
    const secondUrl = 'https://example.com/report?id=2026&opaque=fixture-private-2026';
    const a = N.addSource(root, { ...common, url: firstUrl }).source;
    const b = N.addSource(root, { ...common, url: secondUrl }).source;
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.sourceFingerprint, b.sourceFingerprint);
    assert.match(a.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(N.addSource(root, { ...common, url: firstUrl }).duplicate, true);
    N.setComparison(root, [a.id, b.id]);
    const state = N.load(root);
    assert.equal(state.sources.length, 2);
    assert.deepEqual(state.comparison, [a.id, b.id]);
    const exported = N.exportText(state);
    for (const source of [a, b]) {
      assert(exported.includes(`Source ID: ${source.id}\nBase URL (query/fragment not recorded): https://example.com/report\nSource fingerprint: ${source.sourceFingerprint}`));
      assert(exported.includes(`[${source === a ? 1 : 2}] Annual report — https://example.com/report [source ${source.id}; query/fragment omitted; fingerprint ${source.sourceFingerprint}]`));
    }
    const persisted = fs.readFileSync(path.join(root, 'forge-research-notebook.json'), 'utf8');
    for (const raw of [firstUrl, secondUrl, 'fixture-private-2025', 'fixture-private-2026']) {
      assert(!persisted.includes(raw)); assert(!exported.includes(raw));
    }
    assert.throws(() => N.saveNotes(root, 'session_id=fixture-private-session'), /Invalid notes/);
    assert.throws(() => N.addSource(root, { ...common, excerpt: 'session_id=fixture-private-session', url: 'https://example.com/third' }), /Invalid excerpt/);
    assert.equal(N.load(root).notes, '');
    fs.rmSync(path.join(root, 'forge-research-notebook.key'));
    assert.throws(() => N.addSource(root, { ...common, url: firstUrl }), /identity key missing/);
    assert(!fs.existsSync(path.join(root, 'forge-research-notebook.key')));
    assert.equal(N.load(root).sources.length, 2);
  }) },
  { name: 'structured recognized secrets are rejected at note, excerpt, persisted-state and export boundaries', fn: assert => isolated(root => {
    const input = { url: 'https://example.com/article', title: 'Public article', excerpt: 'Public finding' };
    const source = N.addSource(root, input).source;
    N.saveNotes(root, 'Human comparison only.');
    const file = path.join(root, 'forge-research-notebook.json');
    const baseline = fs.readFileSync(file, 'utf8');
    const fixtureCases = [
      '{"session_id":"fixture-private-session"}',
      '{"access_token":"fixture-private-token"}',
      "{'refresh_token': 'fixture-private-refresh'}",
      'session_id=fixture-private-env',
      'export ACCESS_TOKEN="fixture-private-env-token"',
      'Authorization: ' + 'Bearer ' + 'fixture-private-bearer',
      'Authorization=Bearer fixture-private-assignment',
      'Bearer ' + 'fixture-private-standalone',
    ];
    for (const [i, fixture] of fixtureCases.entries()) {
      assert.throws(() => N.saveNotes(root, fixture), /Invalid notes/, fixture);
      assert.throws(() => N.addSource(root, { ...input, excerpt: fixture }), /Invalid excerpt/, fixture);
      assert.equal(fs.readFileSync(file, 'utf8'), baseline, `rejected fixture ${i} changed disk`);
      for (const field of ['notes', 'excerpt']) {
        const injected = N.load(root);
        if (field === 'notes') injected.notes = fixture;
        else injected.sources[0].excerpt = fixture;
        fs.writeFileSync(file, JSON.stringify(injected));
        assert.throws(() => N.load(root), /Invalid notebook|Invalid excerpt/, `load ${field}: ${fixture}`);
        assert.throws(() => N.exportText(injected), /Invalid notebook|Invalid excerpt/, `exportText ${field}: ${fixture}`);
        const output = path.join(root, `rejected-${i}-${field}.txt`);
        assert.throws(() => N.exportTo(root, output), /Invalid notebook|Invalid excerpt/, `exportTo ${field}: ${fixture}`);
        assert(!fs.existsSync(output), `export created ${output}`);
        fs.writeFileSync(file, baseline);
      }
    }
    assert.equal(N.load(root).sources[0].id, source.id);
    for (const prose of ['The session_id field is optional.', 'Discuss access_token handling without a value.', 'Authorization and Bearer are header terms.']) {
      N.saveNotes(root, prose);
      assert.equal(N.load(root).notes, prose);
      assert(N.exportText(N.load(root)).includes(prose));
    }
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
    assert.throws(() => N.saveNotes(root, 'Authorization=Bearer fixture-private'), /Invalid notes/);
    assert.throws(() => N.setComparison(root, [source.id, source.id]), /Invalid comparison/);
    assert.throws(() => N.setComparison(root, ['unknown']), /Invalid comparison/);
    assert.equal(N.load(root).sources.length, 1);
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  }) },
];
