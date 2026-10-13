'use strict';

/* Gate J — a release archive built on any platform must match the repository. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

module.exports = [
  {
    name: 'git never rewrites line endings on checkout',
    gate: 'J',
    fn(a) {
      // The release job compares packaged files with the repository on Linux.
      // v0.17.0's first tag build was refused because the Windows runner had
      // checked text files out with CRLF.
      const rules = read('.gitattributes').split('\n').filter((line) => line && !line.startsWith('#'));
      a.deepStrictEqual(rules, ['* -text']);
    },
  },
  {
    name: 'every build verifies its checkout before packaging',
    gate: 'J',
    fn(a) {
      const workflow = read('.github/workflows/build.yml');
      const check = workflow.indexOf('- name: Verify checkout is byte-identical to the repository');
      const tests = workflow.indexOf('- name: Run unit tests');
      const packaging = workflow.indexOf('- name: Package application');
      a.ok(check > 0 && check < tests && tests < packaging, 'the check runs before tests and packaging');
      const step = workflow.slice(check, tests);
      a.match(step, /git ls-files --eol \| grep -E 'w\/\(crlf\|mixed\)'/);
      a.match(step, /exit 1/);
      a.doesNotMatch(step, /\n\s+if: /, 'it runs on every platform, not only on tags');
      // The cross-platform comparison it protects is still in the release job.
      a.match(workflow, /--verify-archive=\$archive" "--platform=\$platform" "--arch=\$arch" --verify-source/);
    },
  },
  {
    name: 'no tracked file in this checkout has converted line endings',
    gate: 'J',
    fn(a) {
      let listing;
      try { listing = execFileSync('git', ['ls-files', '--eol'], { cwd: root, encoding: 'utf8' }); }
      catch { return; } // not a git checkout (a source archive): nothing to compare
      const converted = listing.split('\n').filter((line) => /\bw\/(crlf|mixed)\b/.test(line));
      a.deepStrictEqual(converted, []);
    },
  },
];
