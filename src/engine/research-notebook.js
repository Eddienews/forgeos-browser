/* Human-curated, local-only research notebook. Never used by the agent API. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_SOURCES = 100;
const MAX_EXCERPT = 2000;
const MAX_NOTES = 12000;
const MAX_FILE = 512000;
// Recognized assignments include JSON/quoted keys and env-style unquoted keys.
// This is not a generic secret scanner; reject only known credential syntax.
const secret = /(?:\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session[_ -]?id|session[_ -]?token|authorization)["']?\s*[:=]\s*["']?[^\s"'{}\[\],]+|\bBearer\s+(?=[A-Za-z0-9._~+/-]*[0-9._~+/-])[A-Za-z0-9._~+/-]{8,}\b|\b(?:sk-|ghp_|github_pat_)\S+)/i;
const empty = () => ({ version: 1, sources: [], comparison: [], notes: '' });
// Executed only on explicit chrome capture. No page preload or agent API path.
const SELECTION_SCRIPT = `(() => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const blocked = 'input,textarea,select,[contenteditable],form,[autocomplete]';
  const root = node => node.nodeType === 1 ? node : node.parentElement;
  if (root(range.startContainer)?.closest(blocked) || root(range.endContainer)?.closest(blocked)) return null;
  const fragment = range.cloneContents();
  if (fragment.querySelector?.(blocked)) return null;
  const excerpt = selection.toString();
  if (!excerpt || excerpt.length > 2000 || document.title.length > 300 || location.href.length > 2048) return null;
  return { excerpt, title: document.title, url: location.href };
})()`;
const fileFor = base => path.join(base, 'forge-research-notebook.json');
const keyFor = base => path.join(base, 'forge-research-notebook.key');
function fingerprintKey(base, hasSources) {
  const file = keyFor(base);
  if (!fs.existsSync(file)) {
    // Never silently change the identity of previously captured query-bearing sources.
    if (hasSources) throw new Error('Notebook identity key missing');
    fs.mkdirSync(base, { recursive: true });
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('Invalid notebook identity key');
  return key;
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) || secret.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function canonicalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid source URL');
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid source URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname || secret.test(value)) throw new Error('Invalid source URL');
  // Query strings and fragments can carry credentials. Never persist either.
  u.search = ''; u.hash = '';
  if (u.href.length > 2048) throw new Error('Invalid source URL');
  return u.href;
}
function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.sources) || state.sources.length > MAX_SOURCES || !Array.isArray(state.comparison) || state.comparison.length > MAX_SOURCES || typeof state.notes !== 'string' || state.notes.length > MAX_NOTES || secret.test(state.notes) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(state.notes)) throw new Error('Invalid notebook');
  const ids = new Set();
  for (const s of state.sources) {
    if (!s || typeof s.id !== 'string' || !/^[a-f0-9]{32}$/.test(s.id) || ids.has(s.id) || canonicalUrl(s.url) !== s.url || (s.sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(s.sourceFingerprint)) || !Number.isFinite(Date.parse(s.capturedAt))) throw new Error('Invalid source');
    text(s.title, 300, 'title'); text(s.excerpt, MAX_EXCERPT, 'excerpt'); ids.add(s.id);
  }
  if (state.comparison.some(id => !ids.has(id)) || new Set(state.comparison).size !== state.comparison.length) throw new Error('Invalid comparison');
  return state;
}
function load(base) {
  const file = fileFor(base);
  if (!fs.existsSync(file)) return empty();
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_FILE) throw new Error('Notebook exceeds limit');
  return validate(JSON.parse(bytes.toString('utf8')));
}
function save(base, state) {
  validate(state);
  const file = fileFor(base);
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  if (bytes.length > MAX_FILE) throw new Error('Notebook exceeds limit');
  fs.mkdirSync(base, { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
function addSource(base, input) {
  const url = canonicalUrl(input.url);
  const title = text(input.title, 300, 'title');
  if (/[\r\n]/.test(title)) throw new Error('Invalid title');
  const excerpt = text(input.excerpt, MAX_EXCERPT, 'excerpt');
  const state = load(base);
  const hasSuffix = new URL(input.url).href !== url;
  const sourceFingerprint = hasSuffix ? crypto.createHmac('sha256', fingerprintKey(base, state.sources.some(s => s.sourceFingerprint))).update(new URL(input.url).href).digest('hex') : undefined;
  const duplicate = state.sources.find(s => s.url === url && s.excerpt === excerpt && s.sourceFingerprint === sourceFingerprint);
  if (duplicate) return { duplicate: true, source: duplicate, notebook: state };
  if (state.sources.length >= MAX_SOURCES) throw new Error('Notebook source limit reached');
  const source = { id: crypto.randomBytes(16).toString('hex'), url, title, excerpt, capturedAt: new Date().toISOString() };
  if (sourceFingerprint) source.sourceFingerprint = sourceFingerprint;
  state.sources.push(source);
  save(base, state);
  return { duplicate: false, source, notebook: state };
}
function saveNotes(base, notes) {
  if (typeof notes !== 'string' || notes.length > MAX_NOTES || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(notes) || secret.test(notes)) throw new Error('Invalid notes');
  const state = load(base); state.notes = notes; save(base, state); return state;
}
function setComparison(base, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_SOURCES || ids.some(id => typeof id !== 'string')) throw new Error('Invalid comparison');
  const state = load(base); state.comparison = ids; save(base, state); return state;
}
function removeSource(base, id) {
  const state = load(base);
  state.sources = state.sources.filter(s => s.id !== id);
  state.comparison = state.comparison.filter(x => x !== id);
  save(base, state); return state;
}
function exportText(state) {
  validate(state);
  const lines = ['# Research notebook', '', 'Human-curated excerpts and notes; not an AI summary. URLs below are base URLs, not necessarily complete document links. Query/fragment values are never recorded; fingerprints distinguish new captures but cannot reconstruct omitted values or recover older captures.', '', '## Notes', state.notes, '', '## Sources'];
  for (const [i, s] of state.sources.entries()) {
    lines.push('', `[${i + 1}] ${s.title}`, `Source ID: ${s.id}`, `Base URL (query/fragment not recorded): ${s.url}`);
    if (s.sourceFingerprint) lines.push(`Source fingerprint: ${s.sourceFingerprint}`);
    lines.push(`Captured: ${s.capturedAt}`, 'Excerpt:', ...s.excerpt.split(String.fromCharCode(10)).map(line => `> ${line.replace(/\x0d$/, '')}`));
  }
  lines.push('', '## Comparison (selected sources, in order)');
  for (const id of state.comparison) {
    const index = state.sources.findIndex(s => s.id === id);
    const source = state.sources[index];
    const identity = source.sourceFingerprint ? `; query/fragment omitted; fingerprint ${source.sourceFingerprint}` : '; query/fragment not recorded';
    lines.push(`[${index + 1}] ${source.title} — ${source.url} [source ${source.id}${identity}] (${source.capturedAt})`);
  }
  return lines.join('\n') + '\n';
}
function exportTo(base, destination) {
  // Destination must come from the native save dialog. Never take a path from renderer IPC.
  const content = exportText(load(base));
  const fd = fs.openSync(destination, 'wx', 0o600); // no overwrite, including existing symlinks
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
  catch (e) { fs.closeSync(fd); fs.rmSync(destination, { force: true }); throw e; }
  fs.closeSync(fd);
  return { ok: true, bytes: Buffer.byteLength(content) };
}
module.exports = { load, addSource, saveNotes, setComparison, removeSource, exportText, exportTo, canonicalUrl, MAX_EXCERPT, SELECTION_SCRIPT };
