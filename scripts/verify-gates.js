/*
 * scripts/verify-gates.js — assemble the Gate A–K status from three
 * evidence sources and write results/gates.md.
 *
 *   1. unit   -> tests/run-tests.js           (pure engine, Fast)
 *   2. e2e    -> electron tests/e2e/main.js   (real Chromium, fixtures)
 *   3. smoke  -> electron . --smoke           (the real app, example.com)
 *
 * Usage: node scripts/verify-gates.js  [also: npm run verify]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let ELECTRON = null;
try {
  ELECTRON = require('electron');
} catch {}
const RES = path.join(ROOT, 'results');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeoutMs) {
  // execFileSync blocks; wrap with a spawn for timeouts.
  const { spawn } = require('child_process');
  const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
  let out = '';
  let done = false;
  const failed = { ok: false, output: '' };
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { done = true; resolve({ ok: code === 0, code, output: out }); });
    setTimeout(() => {
      if (!done) {
        try { child.kill(); } catch {}
        resolve({ ok: false, code: 'timeout', output: out + '\n[TIMEOUT]' });
      }
    }, timeoutMs);
  });
}

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(RES, name), 'utf8')); }
  catch { return null; }
}

function clearJson(name) {
  try { fs.rmSync(path.join(RES, name), { force: true }); } catch {}
}

function passes(results, test) {
  return !!results && (results.some ? results.some((r) => r.test === test && r.pass) : false);
}

function passesAll(results, test) {
  if (!results || !results.filter) return false;
  const matching = results.filter((r) => r.test === test);
  return matching.length > 0 && matching.every((r) => r.pass);
}

async function main() {
  console.log('=== FORGE BROWSER LAB — GATE VERIFICATION ===\n');
  fs.mkdirSync(RES, { recursive: true });

  // 1. unit
  console.log('> Unit tests (engine) ...');
  clearJson('unit-results.json');
  const unitRun = await run('node', [path.join('tests', 'run-tests.js')], 60000);
  const unit = unitRun.ok ? readJson('unit-results.json') : null;
  if (!unitRun.ok) console.error(unitRun.output);

  // 2. e2e
  if (!ELECTRON || !fs.existsSync(ELECTRON)) {
    console.error('electron binary not found; skipping e2e and smoke.');
    process.exit(2);
  }
  console.log('> E2E (real Chromium + local fixtures) ...');
  clearJson('e2e-results.json');
  const e2eRun = await run(ELECTRON, [path.join('tests', 'e2e', 'main.js')], 120000);
  const e2e = e2eRun.ok ? readJson('e2e-results.json') : null;
  if (!e2eRun.ok) console.error(e2eRun.output);

  // 3. smoke
  console.log('> Smoke (real app, https://example.com) ...');
  clearJson('smoke-report.json');
  const smokeRun = await run(ELECTRON, ['.', '--smoke'], 120000);
  await sleep(1000);
  const smoke = smokeRun.ok ? readJson('smoke-report.json') : null;
  if (!smokeRun.ok) console.error(smokeRun.output);

  const e2eList = e2e ? e2e.results : [];
  const gateTests = {
    A: { label: 'Minimal browser launches', checks: ['A'] },
    B: { label: 'Network interception works', checks: ['A'] },
    C: { label: 'Ad/tracker blocking works', checks: ['A'] },
    D: { label: 'Cookie policy works', checks: ['B', 'C'] },
    E: { label: 'Tracking URL cleanup works', checks: ['D'] },
    F: { label: 'Agent-safe content representation works', checks: ['G'] },
    G: { label: 'Prompt-injection warnings work', checks: ['E'] },
    H: { label: 'Action approval system works', checks: ['F'] },
    I: { label: 'Privacy dashboard works', checks: [] },
    J: { label: 'Tests pass', checks: [] },
    K: { label: 'Page trust boundary holds', checks: ['K'] },
  };

  const rows = [];
  for (const [gate, spec] of Object.entries(gateTests)) {
    const unitGate = unit && unit.gates && unit.gates[gate];
    const unitPass = unitGate && unitGate.failed === 0 && unitGate.total > 0;
    let pass;
    let detail;
    if (gate === 'A') {
      const smokeOk = smoke && smoke.code === 0 && smoke.url && smoke.security && smoke.security.label === 'HTTPS';
      pass = smokeOk && passes(e2eList, 'A');
      detail = `smoke ${smokeOk && smoke.title ? 'PASS (' + smoke.title + ')' : 'FAIL'} + e2e ${passes(e2eList, 'A') ? 'PASS' : 'FAIL'}`;
    } else if (gate === 'J') {
      pass = unit && unit.fail === 0 && e2e && e2e.results.every((r) => r.pass);
      detail = `unit ${unit && unit.fail === 0 ? 'PASS' : 'FAIL'} + e2e all ${e2e ? (e2e.results.every((r) => r.pass) ? 'PASS' : 'FAIL') : 'n/a'}`;
    } else if (gate === 'K') {
      const smokePass = !!(smoke && smoke.pageBoundary && smoke.pageBoundary.safe);
      const e2ePass = passesAll(e2eList, 'K');
      pass = unitPass && e2ePass && smokePass;
      detail = `unit ${unitPass ? 'PASS' : 'FAIL'}(${unitGate ? unitGate.total - unitGate.failed : 0}/${unitGate ? unitGate.total : 0}) + e2e ${e2ePass ? 'PASS' : 'FAIL'} + real-app smoke ${smokePass ? 'PASS' : 'FAIL'}`;
    } else {
      const unitPass = unitGate && unitGate.failed === 0 && unitGate.total > 0;
      const e2ePass = spec.checks.length === 0 ? true : spec.checks.every((t) => passes(e2eList, t));
      pass = unitPass && e2ePass;
      const parts = [];
      if (unitGate && unitGate.total > 0) parts.push(`unit ${unitPass ? 'PASS' : 'FAIL'}(${unitGate.total - unitGate.failed}/${unitGate.total})`);
      if (spec.checks.length) parts.push(`e2e ${e2ePass ? 'PASS' : 'FAIL'}`);
      detail = parts.join(' + ') || 'n/a';
    }
    rows.push({ gate, label: spec.label, status: pass ? 'PASS' : 'FAIL', detail });
  }

  let all = true;
  const tbl = rows.map((r) => `| ${r.gate} | ${r.status} | ${r.detail} |`).join('\n');
  all = rows.every((r) => r.status === 'PASS');

  const md = [
    '# Forge Browser Lab — Gate Verification',
    '',
    `Ran: ${new Date().toISOString()}`,
    `Unit: ${unit ? unit.pass + ' passed / ' + unit.fail + ' failed' : 'n/a'}`,
    `E2E: ${e2e ? e2e.results.filter((r) => r.pass).length + '/' + e2e.results.length + ' checks passed' : 'n/a'}`,
    `Smoke: ${smoke ? JSON.stringify(smoke) : 'n/a'}`,
    '',
    '## Gates',
    '',
    '| Gate | Status | Evidence |',
    '|------|--------|----------|',
    rows.map((r) => `| ${r.gate} | **${r.status}** | ${r.detail} |`).join('\n'),
    '',
    `Overall: **${all ? 'ALL GATES PASS' : 'SOME GATES FAIL'}**`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(RES, 'gates.md'), md);
  console.log('\n=== GATES ===');
  for (const r of rows) console.log(`  Gate ${r.gate}: ${r.status}  (${r.label}) — ${r.detail}`);
  console.log(all ? '\nALL GATES PASS' : '\nSOME GATES FAIL');
  process.exit(all ? 0 : 1);
}

main().catch((e) => { console.error('verify crashed: ', e); process.exit(2); });
