'use strict';

const fs = require('fs');
const path = require('path');
const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/build.yml'), 'utf8');
const os = require('os');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');
const YAML = require('yaml');
const { PACKAGE_FILES, verifyPortableArchive } = require('../../scripts/package-policy');

// Small ZIP writer with valid CRCs and Unix symlink modes; unlike a mocked
// directory listing, this exercises the same bytes downloaded by release.
function syntheticZip(file, entries) {
  let offset = 0;
  const locals = [], centrals = [];
  for (const [name, content = '', mode = 0o100644] of entries) {
    const filename = Buffer.from(name);
    const body = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

module.exports = [
  {
    name: 'mac ZIP rejects private files inside lproj and framework but admits Electron files and symlinks',
    gate: 'J',
    fn(a) {
      const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-mac-zip-'));
      const zip = path.join(temp, 'mac.zip');
      const p = 'ForgeBrowserLab-darwin-x64/ForgeBrowserLab.app/Contents/';
      const entries = [
        ['ForgeBrowserLab-darwin-x64/LICENSE', 'synthetic vendor license'],
        ['ForgeBrowserLab-darwin-x64/LICENSES.chromium.html', 'synthetic vendor notices'],
        [p + 'MacOS/ForgeBrowserLab', 'binary'],
        [p + 'Resources/app.asar', 'asar'],
        [p + 'Resources/en.lproj/locale.pak', 'locale'],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'binary'],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/pt_PT_MASCULINE.lproj/', '', 0o40755],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/pt_PT_MASCULINE.lproj/locale.pak', 'locale'],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN_FEMININE.lproj/', '', 0o40755],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN_FEMININE.lproj/locale.pak', 'locale'],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/', '', 0o40755],
        [p + 'Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources', 'synthetic signature'],
        [p + 'Frameworks/Electron Framework.framework/Versions/Current', 'A', 0o120777],
        [p + 'Frameworks/Electron Framework.framework/Electron Framework', 'Versions/Current/Electron Framework', 0o120777],
      ];
      try {
        syntheticZip(zip, entries);
        a.ok(verifyPortableArchive(zip, 'darwin', 'x64'));
        for (const privatePath of ['ForgeBrowserLab-darwin-x64/private-note.txt',
          p + 'Resources/en.lproj/private-key.txt',
          p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN_PRIVATE.lproj/locale.pak',
          p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/zh_PRIVATE_FEMININE.lproj/locale.pak',
          p + 'Resources/pt_PT_MASCULINE.lproj/locale.pak',
          p + 'Frameworks/Mantle.framework/Versions/A/Resources/zh_CN_FEMININE.lproj/locale.pak',
          p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/pt_PT_MASCULINE.lproj/private-key.txt',
          p + 'Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/private-key.txt',
          p + 'Frameworks/Electron Framework.framework/private-key.txt']) {
          syntheticZip(zip, [...entries, [privatePath, 'synthetic secret']]);
          a.throws(() => verifyPortableArchive(zip, 'darwin', 'x64'), /Unapproved ZIP member/);
        }
        const signatureDir = p + 'Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/';
        const signatureFile = signatureDir + 'CodeResources';
        for (const [target, mode] of [
          [signatureDir, 0o120777], [signatureDir, 0o100644],
          [signatureFile, 0o120777], [signatureFile, 0o40755],
        ]) {
          const mutated = entries.map(([name, content, originalMode]) =>
            name === target ? [name, 'A', mode] : [name, content, originalMode]);
          syntheticZip(zip, mutated);
          a.throws(() => verifyPortableArchive(zip, 'darwin', 'x64'),
            /Invalid code signature ZIP mode/, `${target} mode ${mode.toString(8)} must fail`);
        }
        for (const localeName of ['pt_PT_MASCULINE', 'zh_CN_FEMININE']) {
          const localeDir = p + 'Frameworks/Electron Framework.framework/Versions/A/Resources/' + localeName + '.lproj/';
          for (const [target, mode] of [
            [localeDir, 0o120777], [localeDir, 0o100644],
            [localeDir + 'locale.pak', 0o120777], [localeDir + 'locale.pak', 0o40755],
          ]) {
            const mutated = entries.map(([name, content, originalMode]) =>
              name === target ? [name, 'A', mode] : [name, content, originalMode]);
            syntheticZip(zip, mutated);
            a.throws(() => verifyPortableArchive(zip, 'darwin', 'x64'),
              /Invalid gendered locale ZIP mode/, `${target} mode ${mode.toString(8)} must fail`);
          }
        }
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    },
  },
  {
    name: 'release compares downloaded ZIP app.asar against checkout source after extraction',
    gate: 'J',
    async fn(a) {
      const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-release-asar-'));
      try {
        const stage = path.join(temp, 'stage');
        for (const member of PACKAGE_FILES) {
          const target = path.join(stage, member);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(__dirname, '../..', member), target);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
        for (const field of ['private', 'scripts', 'devDependencies']) delete manifest[field];
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        const archive = path.join(temp, 'app.asar');
        const zip = path.join(temp, 'release.zip');
        const prefix = 'ForgeBrowserLab-linux-x64/';
        const entries = () => [[prefix + 'ForgeBrowserLab', 'binary'],
          [prefix + 'resources/app.asar', fs.readFileSync(archive)]];
        await asar.createPackage(stage, archive);
        syntheticZip(zip, entries());
        a.ok(verifyPortableArchive(zip, 'linux', 'x64', { sourceRoot: path.join(__dirname, '../..') }));
        const cli = [path.join(__dirname, '../../scripts/make-portable.js'),
          '--verify-archive=' + zip, '--platform=linux', '--arch=x64', '--verify-source'];
        a.match(execFileSync(process.execPath, cli, { encoding: 'utf8' }), /app\.asar source bytes/);
        fs.writeFileSync(path.join(stage, 'src/main.js'), 'synthetic modified executable source');
        await asar.createPackage(stage, archive);
        syntheticZip(zip, entries());
        a.throws(() => verifyPortableArchive(zip, 'linux', 'x64',
          { sourceRoot: path.join(__dirname, '../..') }), /app\.asar content mismatch: src\/main\.js/);
        a.throws(() => execFileSync(process.execPath, cli, { stdio: 'pipe' }), error =>
          error.stderr.toString().includes('app.asar content mismatch: src/main.js'));
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      a.match(workflow, /npm ci --ignore-scripts/);
      a.match(workflow, /--verify-source/);
    },
  },
  {
    name: 'release rejects external ZIP with synthetic private download member',
    gate: 'J',
    fn(a) {
      const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-zip-gate-'));
      try {
        const archive = path.join(temp, 'ForgeBrowserLab-portable-win32-x64.zip');
        const fixture = path.join(temp, 'fixture');
        fs.mkdirSync(path.join(fixture, 'resources'), { recursive: true });
        fs.mkdirSync(path.join(fixture, 'downloads'), { recursive: true });
        fs.writeFileSync(path.join(fixture, 'ForgeBrowserLab.exe'), 'synthetic exe');
        fs.writeFileSync(path.join(fixture, 'resources/app.asar'), 'synthetic asar');
        const makeZip = () => {
          if (process.platform === 'win32') {
            // Available on the Windows runner and scratch host.
            execFileSync('powershell', ['-NoProfile', '-Command',
              `Compress-Archive -Path '${fixture.replace(/'/g, "''")}\\*' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`]);
          } else {
            fs.rmSync(archive, { force: true });
            execFileSync('zip', ['-q', '-r', archive, 'ForgeBrowserLab.exe', 'resources', 'downloads'], { cwd: fixture });
          }
        };
        makeZip();
        const args = [path.join(__dirname, '../../scripts/make-portable.js'), '--verify-archive=' + archive,
          '--platform=win32', '--arch=x64'];
        execFileSync(process.execPath, args, { stdio: 'pipe' });
        fs.writeFileSync(path.join(fixture, 'downloads/synthetic-private-note.txt'), 'synthetic private note');
        makeZip();
        a.throws(() => execFileSync(process.execPath,
          args, { stdio: 'pipe' }), error =>
          error.stderr.toString().includes('Unapproved ZIP member: downloads/synthetic-private-note.txt'));
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'release fails if any packaged target is missing',
    gate: 'J',
    fn(a) {
      a.match(workflow, /if-no-files-found: error/);
      for (const target of ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
        a.ok(workflow.includes(`ForgeBrowserLab-portable-${target}.zip`), `missing ${target}`);
      }
      a.match(workflow, /unexpected release archive/);
      a.match(workflow, /unzip -t/);
      a.match(workflow, /node \.\.\/scripts\/make-portable\.js.*--verify-archive=/);
    },
  },
  {
    name: 'PR verifies five target-OS archives without uploading or publishing them',
    gate: 'J',
    fn(a) {
      const document = YAML.parse(workflow);
      a.deepStrictEqual(Object.keys(document.on).sort(), ['pull_request', 'push']);
      a.deepStrictEqual(document.on.push.tags, ['v*']);
      a.deepStrictEqual(Object.keys(document.jobs).sort(), ['build', 'release']);
      const { build, release } = document.jobs;
      a.deepStrictEqual(build.permissions, { contents: 'read' });
      a.strictEqual(build['runs-on'], '${{ matrix.os }}');
      const matrix = build.strategy.matrix;
      a.deepStrictEqual(Object.keys(matrix).sort(), ['arch', 'exclude', 'os']);
      const combinations = matrix.os.flatMap(os => matrix.arch.map(arch => `${os}/${arch}`))
        .filter(target => !matrix.exclude.some(x => target === `${x.os}/${x.arch}`)).sort();
      a.deepStrictEqual(combinations, [
        'windows-latest/x64', 'macos-latest/x64', 'macos-latest/arm64',
        'ubuntu-latest/x64', 'ubuntu-latest/arm64',
      ].sort());
      const step = name => {
        const matching = build.steps.filter(item => item.name === name);
        a.strictEqual(matching.length, 1, `${name} must occur exactly once`);
        return matching[0];
      };
      const packageStep = step('Package application');
      const archiveStep = step('Create portable archive');
      const integrityStep = step('Verify ZIP integrity');
      const verifyStep = step('Verify target-OS portable archive');
      for (const current of [packageStep, archiveStep, integrityStep, verifyStep]) {
        a.ok(!Object.hasOwn(current, 'if'), `${current.name} must run on PR and tag`);
      }
      a.match(packageStep.run, /node scripts\/package\.js --platform=.*--arch=/);
      a.match(archiveStep.run, /node scripts\/make-portable\.js --platform=.*--arch=/);
      a.match(integrityStep.run, /zipfile\.ZipFile\(.*\).*testzip\(\)/s);
      a.match(verifyStep.run, /node scripts\/make-portable\.js --verify-archive=.*--platform=.*--arch=.*--verify-source/);
      const names = build.steps.map(item => item.name);
      a.ok(names.indexOf('Run unit tests') < names.indexOf('Package application'));
      a.ok(names.indexOf('Run isolated Electron transport and approval E2E') < names.indexOf('Package application'));
      a.ok(names.indexOf('Package application') < names.indexOf('Create portable archive'));
      a.ok(names.indexOf('Create portable archive') < names.indexOf('Verify ZIP integrity'));
      a.ok(names.indexOf('Verify ZIP integrity') < names.indexOf('Verify target-OS portable archive'));
      const uploads = Object.entries(document.jobs).flatMap(([job, value]) =>
        value.steps.filter(item => /^actions\/upload-artifact@/.test(item.uses || ''))
          .map(item => ({ job, item })));
      a.strictEqual(uploads.length, 1, 'only the tag build may upload artifacts');
      a.strictEqual(uploads[0].job, 'build');
      a.strictEqual(uploads[0].item.name, 'Upload artifacts');
      a.strictEqual(uploads[0].item.if, "github.event_name == 'push'");
      a.deepStrictEqual(release.permissions, { contents: 'write' });
      a.strictEqual(release.if,
        "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
      a.strictEqual(release.needs, 'build');
      const publishers = Object.entries(document.jobs).flatMap(([job, value]) =>
        value.steps.filter(item => /\bgh release (create|edit|upload)\b/.test(item.run || ''))
          .map(item => ({ job, item })));
      a.strictEqual(publishers.length, 1, 'only the tag-gated release job may publish');
      a.strictEqual(publishers[0].job, 'release');
      a.strictEqual(publishers[0].item.name, 'Publish GitHub Release');
    },
  },
  {
    name: 'release builds depend on the real isolated Electron E2E transport gate',
    gate: 'J',
    fn(a) {
      a.match(workflow, /Run isolated Electron transport and approval E2E\s+if: matrix\.os == 'windows-latest' && matrix\.arch == 'x64'\s+env:\s+FORGE_FIXTURE_PYTHON: python\s+FORGE_QUIC_SITE: .*\s+PYTHONPATH: .*\s+run: npm run test:e2e/);
      a.match(workflow, /needs: build/);
      a.match(fs.readFileSync(path.join(__dirname, '../e2e/agent-proxy.js'), 'utf8'),
        /agent WebRTC TURN\/TCP cannot directly reach loopback/);
      a.match(workflow, /actions\/setup-python@v5/);
      a.match(workflow, /aioquic==1\.3\.0/);
      a.match(workflow, /PYTHONPATH:.*forge-quic-site/);
      a.match(fs.readFileSync(path.join(__dirname, '../e2e/main.js'), 'utf8'), /await runQuicE2E\(record\)/);
      const runner = fs.readFileSync(path.join(__dirname, '../e2e/quic.js'), 'utf8');
      a.match(runner, /afterAgent\[key\] - afterHuman\[key\] === 0/);
      a.match(runner, /human.*datagramReceived/s);
    },
  },
  {
    name: 'QUIC counter gate rejects missing malformed and nonzero agent deltas',
    gate: 'J',
    fn(a) {
      const { agentCountersClosed, validCounts } = require('../e2e/quic');
      const baseline = Object.fromEntries(['udp_packets', 'udp_bytes', 'quic_protocol_negotiated',
        'quic_handshake_completed', 'h3_webtransport_connect', 'h3_webtransport_accepted',
        'h3_datagrams'].map(key => [key, 1]));
      a.ok(validCounts(baseline));
      a.ok(agentCountersClosed(baseline, { ...baseline }));
      for (const key of Object.keys(baseline)) {
        a.ok(!agentCountersClosed(baseline, { ...baseline, [key]: 2 }), `nonzero ${key}`);
        a.ok(!agentCountersClosed(baseline, { ...baseline, [key]: undefined }), `missing ${key}`);
        a.ok(!agentCountersClosed(baseline, { ...baseline, [key]: '1' }), `invalid ${key}`);
      }
      a.ok(!agentCountersClosed(null, baseline));
    },
  },
  {
    name: 'release emits checksums without replacing previous assets',
    gate: 'J',
    fn(a) {
      a.match(workflow, /sha256sum.*SHA256SUMS/);
      a.match(workflow, /sha256sum -c SHA256SUMS/);
      a.doesNotMatch(workflow, /--clobber/);
    },
  },
];
