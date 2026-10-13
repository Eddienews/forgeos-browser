/*
 * smoke.js — `--smoke`: an automated self-check on the real application, used
 * by scripts/verify-gates.js and by packaging checks. It opens one real page,
 * confirms it loaded over HTTPS, and confirms the page cannot reach Node,
 * Electron or the chrome bridge. The result is printed and written to
 * results/smoke-report.json, and the process exits with it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * @param {{logger: {log: Function}, getRuntimeBase: Function, createTab: Function,
 *   switchTab: Function, refreshAgentView: Function, securityFor: Function}} ctx
 */
function createSmoke(ctx) {
  const log = ctx.logger;

  let smokeDone = false;
  async function runSmoke() {
    if (smokeDone) return;
    smokeDone = true;
    const reportPath = path.join(ctx.getRuntimeBase(), 'results', 'smoke-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const finish = (code) => {
      // Merge finished/code onto any report already written (do not clobber it).
      let obj = {};
      try { obj = JSON.parse(fs.readFileSync(reportPath, 'utf8') || '{}'); } catch {}
      obj.finished = true;
      obj.code = code;
      try { fs.writeFileSync(reportPath, JSON.stringify(obj, null, 2)); } catch {}
      setTimeout(() => app.exit(code), 4500); // hold ~4.5s so the window can be captured
    };
    try {
      log.log('INFO', 'smoke start');
      const t = ctx.createTab('https://example.com');
      ctx.switchTab(t.id, { focus: false });
      log.log('INFO', 'smoke tab created', { id: t.id });
      const navOk = await new Promise((resolve) => {
        let settled = false;
        const done = (ok, extra) => { if (!settled) { settled = true; resolve(extra || ok); } };
        t.wc.once('did-navigate', () => {
          log.log('INFO', 'smoke did-navigate');
          setTimeout(async () => {
            await ctx.refreshAgentView(t);
            done(true);
          }, 1200);
        });
        t.wc.once('did-fail-load', (_e, code, desc) => { log.log('ERROR', 'smoke did-fail-load', { code, desc: String(desc).slice(0, 100) }); done(false, { failed: code }); });
        setTimeout(() => done(false, { failed: 'timeout' }), 25000);
      });
      const report = {
        smoke: true,
        url: t.url,
        title: t.title,
        security: ctx.securityFor(t),
        pageCounts: t.pageCounts,
        agentView: t.lastAgentView ? {
          url: t.lastAgentView.url,
          title: t.lastAgentView.title,
          untrusted: t.lastAgentView.security.untrusted,
          authority: t.lastAgentView.security.instruction_authority,
          injection: t.lastAgentView.security.prompt_injection_severity,
          paragraphs: (t.lastAgentView.content.paragraphs || []).slice(0, 2),
          links: (t.lastAgentView.content.links || []).slice(0, 3),
        } : null,
        navigation: navOk === true ? 'OK' : JSON.stringify(navOk),
      };
      report.pageBoundary = await t.wc.executeJavaScript(`({
        processType: typeof window.process,
        requireType: typeof window.require,
        forgeType: typeof window.forge,
        electronType: typeof window.electron
      })`);
      report.pageBoundary.safe = report.pageBoundary.processType === 'undefined' &&
        report.pageBoundary.requireType === 'undefined' &&
        report.pageBoundary.forgeType === 'undefined' &&
        report.pageBoundary.electronType === 'undefined';
      console.log('SMOKE_REPORT ' + JSON.stringify(report));
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      const pass = report.security && report.security.label === 'HTTPS' && navOk === true && report.pageBoundary.safe;
      log.log(pass ? 'INFO' : 'ERROR', 'smoke ' + (pass ? 'PASS' : 'FAIL'), { url: report.url, security: report.security && report.security.label, title: report.title });
      finish(pass ? 0 : 1);
    } catch (e) {
      const detail = { smoke: true, error: String(e && e.stack || e).slice(0, 500) };
      console.log('SMOKE_REPORT ' + JSON.stringify(detail));
      log.log('ERROR', 'smoke failed', { error: String(e).slice(0, 200) });
      try { fs.writeFileSync(reportPath, JSON.stringify(detail, null, 2)); } catch {}
      setTimeout(() => app.exit(2), 400);
    }
  }

  return { runSmoke };
}

module.exports = { createSmoke };
