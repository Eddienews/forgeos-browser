/*
 * run-tests.js — zero-dependency test runner for the Forge Browser Lab
 * engine. Runs every tests/unit/*.test.js suite, groups results by gate
 * (A–K), and exits non-zero on any failure. No network access is used.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const unitDir = path.join(__dirname, 'unit');
const resultsFile = path.join(__dirname, '..', 'results', 'unit-results.json');

let pass = 0;
let fail = 0;
const failures = [];
const gateStats = new Map(); // gate -> { total, failed, names: [] }

function noteGate(gate, name, ok) {
  if (!gate) return;
  if (!gateStats.has(gate)) gateStats.set(gate, { total: 0, failed: 0, names: [] });
  const g = gateStats.get(gate);
  g.total += 1;
  if (!ok) { g.failed += 1; g.names.push(name); }
}

const files = fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.js')).sort();
if (files.length === 0) {
  console.error('No test files found in tests/unit');
  process.exit(1);
}

const started = Date.now();

for (const f of files) {
  const mod = require(path.join(unitDir, f));
  const suite = Array.isArray(mod) ? mod : mod.tests;
  if (!Array.isArray(suite)) {
    console.error(`Suite ${f} must export an array of tests`);
    process.exit(1);
  }
  for (const t of suite) {
    const id = `${f.replace('.test.js', '')} :: ${t.name}`;
    try {
      t.fn(require('assert'));
      pass += 1;
      noteGate(t.gate, id, true);
    } catch (e) {
      fail += 1;
      failures.push(`${id}\n    ${e.message}`);
      noteGate(t.gate, id, false);
    }
  }
}

const ms = Date.now() - started;

console.log('\n=== FORGE BROWSER LAB — UNIT TESTS ===\n');
for (const [gate, g] of [...gateStats.entries()].sort()) {
  const status = g.failed === 0 ? 'PASS' : 'FAIL';
  console.log(`  Gate ${gate}: ${status}  (${g.total - g.failed}/${g.total})`);
}
console.log(`\n  Total: ${pass} passed, ${fail} failed  (${ms} ms)\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
}

// Machine-readable summary for scripts/verify-gates.js
const gatesOut = {};
for (const [gate, g] of gateStats) {
  gatesOut[gate] = { total: g.total, failed: g.failed, failedNames: g.names };
}
fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
fs.writeFileSync(resultsFile, JSON.stringify({ pass, fail, gates: gatesOut, ms }, null, 2));

process.exit(fail === 0 ? 0 : 1);
