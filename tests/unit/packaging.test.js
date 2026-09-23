'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_FILES } = require('../../scripts/package-policy');
const asar = require('@electron/asar');
const vm = require('vm');
const { isPackageExcluded, PACKAGE_IGNORE_SOURCE } = require('../../scripts/package-policy');

const packagingSource = fs.readFileSync(
  path.join(__dirname, '../../scripts/package.js'),
  'utf8',
);
const portableSource = fs.readFileSync(path.join(__dirname, '../../scripts/make-portable.js'), 'utf8');

function probePortable(platform) {
  const checked = [];
  const commands = [];
  const written = [];
  const removed = [];
  const fakeFs = {
    existsSync(file) { checked.push(file.replace(/\\/g, '/')); return true; },
    mkdirSync() {},
    writeFileSync(file, content) { written.push({ file, content }); },
    statSync() { return { size: 1024 }; },
    unlinkSync() {},
    rmSync(file) { removed.push(file); },
  };
  vm.runInNewContext(portableSource, {
    __dirname: path.join(__dirname, '../../scripts'),
    require(id) {
      if (id === 'fs') return fakeFs;
      if (id === 'path') return path;
      if (id === './package-policy') return { verifyPortableArchive() {} };
      if (id === 'child_process') return {
        execSync(command, options) { commands.push({ command, options }); },
        execFileSync(file, args, options) { commands.push({ command: [file, ...args].join(' '), options }); },
      };
      if (id.endsWith('package.json')) return { version: '0.15.0' };
      throw new Error(`Unexpected require: ${id}`);
    },
    process: { platform, arch: 'x64', execPath: process.execPath, argv: ['node', 'make-portable.js', `--platform=${platform}`] },
    console: { log() {} },
  });
  return { checked, commands, written, removed };
}

module.exports = [
  {
    name: 'packaging uses a Windows-safe Node entrypoint',
    gate: 'J',
    fn(a) {
      a.match(packagingSource, /const nodeCommand = process\.execPath/);
      a.match(packagingSource, /execFileSync\(nodeCommand, \[packagerScript, \.\.\.args\]/);
      a.doesNotMatch(packagingSource, /const npxCommand/);
    },
  },
  {
    name: 'package policy excludes private checkout state and admits runtime assets',
    gate: 'J',
    fn(a) {
      const forbidden = ['.env', '.env.local', '.hermes/HANDOFF.md', 'forge-inference-key',
        'scripts/_diag-jev.js', 'tests/unit/packaging.test.js', 'src/.env',
        'src/ext/_private.js', 'assets/.hermes/HANDOFF.md'];
      const required = ['package.json', 'src/main.js', 'src/preload.js',
        'src/engine/agent-network-proxy.js', 'src/renderer/ui.js', 'src/lists/ad-domains.json', 'lists/easylist.txt',
        'assets/forgeos-banner.png'];
      for (const candidate of forbidden) a.strictEqual(isPackageExcluded(candidate), true, candidate);
      for (const candidate of required) a.strictEqual(isPackageExcluded(candidate), false, candidate);
      const ignore = new RegExp(PACKAGE_IGNORE_SOURCE);
      for (const candidate of forbidden) a.strictEqual(ignore.test('/' + candidate), true, candidate);
      a.match(packagingSource, /--ignore=\$\{PACKAGE_IGNORE_SOURCE\}/);
    },
  },
  {
    name: 'package policy is exact-file membership even within runtime trees',
    gate: 'J',
    fn(a) {
      const forbidden = ['src/private-notes.txt', 'src/engine/extra.js', 'src/ext/extra.js',
        'src/renderer/extra.html', 'src/lists/extra.json', 'assets/secret.txt',
        'lists/extra.txt', 'src/forge-inference-key.tmp', 'src/renderer/ui.js.bak',
        'assets/icon.png', 'src/engine/nested/extra.js'];
      for (const file of forbidden) a.strictEqual(isPackageExcluded(file), true, file);
      for (const dir of ['src', 'src/engine', 'src/renderer', 'src/ext', 'src/lists', 'assets', 'lists']) {
        a.strictEqual(isPackageExcluded(dir), false, `directory ${dir} must be traversable`);
      }
      for (const file of ['src/main.js', 'src/engine/settings.js', 'src/renderer/style.css',
        'src/lists/ad-domains.json', 'assets/forgeos-banner.png', 'lists/easyprivacy.txt']) {
        a.strictEqual(isPackageExcluded(file), false, file);
      }
      a.strictEqual(new RegExp(PACKAGE_IGNORE_SOURCE).test('/src/private-notes.txt'), true);
    },
  },
  {
    name: 'portable packaging checks renamed mac binary and writes no stale instructions',
    gate: 'J',
    fn(a) {
      const run = probePortable('darwin');
      a.ok(run.removed.some(file => file.endsWith('ForgeBrowserLab-darwin-x64')));
      a.ok(run.commands.some(({ command }) => command.includes('package.js')));
      a.ok(run.written.some(({ content }) => !content.includes('node scripts/update-lists.js')));
    },
  },
  {
    name: 'Linux portable archive has relative members, not absolute checkout paths',
    gate: 'J',
    fn(a) {
      const run = probePortable('linux');
      const zip = run.commands.find(({ command }) => command.startsWith('zip '));
      a.ok(zip, 'zip must be invoked');
      a.ok(!zip.command.includes(path.join(__dirname, '../..').replace(/\\/g, '/')),
        'zip must not archive an absolute source path');
      a.ok(zip.options.cwd.endsWith('dist'), 'zip cwd must be dist');
    },
  },
  {
    name: 'archive inventory rejects synthetic leaves in real app.asar',
    gate: 'J',
    async fn(a) {
      a.match(packagingSource, /const members = verifyPackageArchive\(archivePath\)/);
      const { verifyPackageArchive } = require('../../scripts/package');
      a.strictEqual(typeof verifyPackageArchive, 'function');
      const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-package-test-'));
      try {
        const stage = path.join(temp, 'stage');
        fs.mkdirSync(stage);
        for (const file of PACKAGE_FILES) {
          const dest = path.join(stage, file);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(__dirname, '../..', file), dest);
        }
        const fixtureManifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
        for (const field of ['private', 'scripts', 'devDependencies']) delete fixtureManifest[field];
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(fixtureManifest, null, 2) + '\n');
        const archive = path.join(temp, 'app.asar');
        await asar.createPackage(stage, archive);
        const actual = asar.listPackage(archive)
          .filter(member => !asar.statFile(archive, member.replace(/^[\\/]+/, '')).files)
          .map(member => member.replace(/\\/g, '/').replace(/^\/+/, '')).sort();
        a.deepStrictEqual(actual, [...PACKAGE_FILES].sort());
        a.deepStrictEqual(verifyPackageArchive(archive), actual);
        fs.writeFileSync(path.join(stage, 'src/main.js'), 'synthetic altered source byte');
        const alteredArchive = path.join(temp, 'altered.asar');
        await asar.createPackage(stage, alteredArchive);
        a.throws(() => verifyPackageArchive(alteredArchive), /content mismatch: src\/main\.js/i);
        fs.copyFileSync(path.join(__dirname, '../../src/main.js'), path.join(stage, 'src/main.js'));
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ ...fixtureManifest, private: false }, null, 2) + '\n');
        const alteredManifestArchive = path.join(temp, 'altered-manifest.asar');
        await asar.createPackage(stage, alteredManifestArchive);
        a.throws(() => verifyPackageArchive(alteredManifestArchive), /content mismatch: package\.json/i);
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(fixtureManifest, null, 2) + '\n');
        for (const extra of ['src/private-notes.txt', 'assets/secret.txt', 'lists/extra.txt',
          'src/forge-inference-key.tmp']) {
          const dest = path.join(stage, extra);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, 'synthetic packaging leak fixture');
        }
        const contaminatedArchive = path.join(temp, 'contaminated.asar');
        await asar.createPackage(stage, contaminatedArchive);
        a.throws(() => verifyPackageArchive(contaminatedArchive), error =>
          /unapproved/i.test(error.message) &&
          ['src/private-notes.txt', 'assets/secret.txt', 'lists/extra.txt',
            'src/forge-inference-key.tmp'].every(file => error.message.includes(file)));
        fs.rmSync(path.join(stage, 'src/main.js'));
        const incompleteArchive = path.join(temp, 'incomplete.asar');
        await asar.createPackage(stage, incompleteArchive);
        a.throws(() => verifyPackageArchive(incompleteArchive), /missing.*src\/main\.js/i);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
];
