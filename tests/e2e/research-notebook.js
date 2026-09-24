'use strict';
const fs = require('fs');
const path = require('path');
const notebook = require('../../src/engine/research-notebook');
async function runNotebookE2E(wc, pageUrl, base, record) {
  await wc.loadURL(pageUrl);
  await wc.executeJavaScript(`(() => {
    document.title = '<img src=x onerror=alert(1)>';
    const p = document.createElement('p'); p.id = 'notebook-safe';
    p.textContent = '<script>alert(1)</script> human finding'; document.body.append(p);
    const secret = document.createElement('div'); secret.contentEditable = 'true';
    secret.id = 'notebook-editable'; secret.textContent = 'fixture-private-entry'; document.body.append(secret);
    const input = document.createElement('input'); input.type = 'password';
    input.value = 'fixture-private-password'; document.body.append(input);
    const r = document.createRange(); r.selectNodeContents(p);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
  })()`);
  const selected = await wc.executeJavaScript(notebook.SELECTION_SCRIPT, true);
  record('NOTEBOOK', 'real Chromium selection captures bounded text only',
    selected?.excerpt === '<script>alert(1)</script> human finding' && selected.url === pageUrl,
    'selection matched synthetic hostile prose');
  const stored = notebook.addSource(base, selected).source;
  const file = path.join(base, 'forge-research-notebook.json');
  record('NOTEBOOK', 'human excerpt persisted with canonical URL, title, timestamp outside checkout',
    stored.url === pageUrl && stored.title === '<img src=x onerror=alert(1)>' &&
    Number.isFinite(Date.parse(stored.capturedAt)) && fs.existsSync(file), 'disk state and reference validated');
  await wc.executeJavaScript(`(() => {
    const r = document.createRange(); r.selectNodeContents(document.getElementById('notebook-editable'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
  })()`);
  record('NOTEBOOK', 'contenteditable selection rejected by real renderer',
    await wc.executeJavaScript(notebook.SELECTION_SCRIPT, true) === null, 'no capture');
  await wc.executeJavaScript(`(() => {
    const r = document.createRange(); r.selectNodeContents(document.querySelector('input'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
  })()`);
  record('NOTEBOOK', 'password input selection rejected by real renderer',
    await wc.executeJavaScript(notebook.SELECTION_SCRIPT, true) === null, 'no capture');
  notebook.saveNotes(base, 'Human comparison only.');
  notebook.setComparison(base, [stored.id]);
  const output = path.join(base, 'notebook-export.txt');
  notebook.exportTo(base, output);
  const exported = fs.readFileSync(output, 'utf8');
  record('NOTEBOOK', 'export references persistent source without executing hostile markup',
    exported.includes(`URL: ${pageUrl}\nCaptured: ${stored.capturedAt}`) &&
    exported.includes('> <script>alert(1)</script> human finding') &&
    notebook.load(base).comparison[0] === stored.id, 'exact URL/timestamp and quoted excerpt on disk');
}
module.exports = { runNotebookE2E };
