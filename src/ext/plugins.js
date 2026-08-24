/*
 * plugins.js — Forge Browser Lab plugin runner (Phase 25 extension point).
 *
 * Two lab plugins backed by LOCAL tooling already on this machine:
 *   ⬇ download video  → yt-dlp <url> -o downloads/
 *   ✎ transcript      → yt-dlp --skip-download --write-auto-subs --sub-lang en,pt
 *
 * Security posture:
 *  - The page URL is passed through the PERMISSION GATE first
 *    (DOWNLOAD_FILE → ASK → human approves via native dialog).
 *  - Only the URL of the ACTIVE tab is used; the renderer never supplies
 *    arbitrary commands or paths.
 *  - Output goes ONLY to the laboratory downloads/ directory.
 *  - Nothing is auto-executed after download (Phase 13).
 *  - Progress streams back to the chrome UI over IPC; nothing leaves the
 *    machine except the request to the video host made by yt-dlp itself.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const settings = require('../engine/settings');

// Downloads dir: outside the asar when packaged (next to the .exe),
// project root in dev. Mirrors main.js RUNTIME_BASE logic.
const IS_PACKAGED = __dirname.includes('app.asar');
const DOWNLOADS_DIR = IS_PACKAGED
  ? path.join(path.dirname(process.execPath), 'downloads')
  : path.join(__dirname, '..', '..', 'downloads');
const YT_DLP_CANDIDATES = [
  process.env.FORGE_YTDLP, // optional override
  'C:/Users/eddie/AppData/Local/hermes/hermes-agent/venv/Scripts/yt-dlp.exe',
  'C:/Users/eddie/AppData/Local/hermes/hermes-agent/venv/Scripts/yt-dlp',
];

function resolveYtDlp() {
  for (const c of YT_DLP_CANDIDATES) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Extract a youtube-ish video id from a URL, or null. */
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = u.pathname.match(/\/(shorts|embed)\/([\w-]{6,})/);
      if (m) return m[2];
    }
    if (u.hostname === 'youtu.be') {
      const m = u.pathname.match(/^\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/**
 * Flatten a WebVTT subtitle file into plain readable text:
 * strips the header, cue numbers, timestamps, inline tags (<c>, <00:00:01.000>),
 * duplicate consecutive lines (auto-captions roll), and metadata blocks.
 */
function vttToPlainText(vttPath) {
  const raw = fs.readFileSync(vttPath, 'utf8');
  const out = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^(Kind|Language|NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;                                   // cue number
    if (line.includes('-->')) continue;                                 // timestamp line
    line = line
      .replace(/<[^>]+>/g, '')          // inline tags <c>, <00:00:01.000>
      .replace(/\{\\[^}]*\}/g, '')      // ASS-style overrides {\an8}
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\[\s*[_—-]*\s*\]/g, '') // [ __ ] sound-marker placeholders
      .replace(/\[[^\]]{0,30}\]/g, (m) => /[a-z]{4}/i.test(m) ? m : ''); // [Music], [Applause]
    if (!line) continue;
    // Auto-captions repeat the previous block with one new word; skip dups.
    if (out.length && out[out.length - 1] === line) continue;
    // Rolling-caption dedup: drop short lines fully contained in the previous.
    if (out.length && line.length <= out[out.length - 1].length + 12 &&
        out[out.length - 1].includes(line)) continue;
    out.push(line);
  }
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  return text + '\n';
}

class PluginRunner {
  constructor({ log }) {
    this.log = log;
    this.jobs = new Map(); // jobId -> child process
    this.nextId = 1;
  }

  /**
   * @param {'video'|'transcript'} kind
   * @param {string} pageUrl active tab URL
   * @param {() => Promise<{approved:boolean}>} approve permission-gate callback
   * @param {(evt: object) => void} emit progress callback (chrome UI)
   */
  async run(kind, pageUrl, approve, emit) {
    const jobId = 'job-' + this.nextId++;
    const ytdlp = resolveYtDlp();
    if (!ytdlp) {
      const e = { jobId, kind, state: 'error', error: 'yt-dlp not found. Set FORGE_YTDLP or install it.' };
      emit(e);
      return e;
    }
    const vid = extractVideoId(pageUrl);
    if (!vid && /youtube|youtu\.be/.test(pageUrl)) {
      const e = { jobId, kind, state: 'error', error: 'No video id found in the current URL.' };
      emit(e); return e;
    }
    if (!vid) {
      const e = { jobId, kind, state: 'error', error: 'This plugin currently supports YouTube URLs only.' };
      emit(e); return e;
    }

    // Permission gate: downloads are consequential → ASK.
    const gate = await approve();
    if (!gate.approved) {
      const r = { jobId, kind, state: 'denied', reason: 'Human denied the action' };
      this.log.log('DENY', 'plugin ' + kind + ' denied', { url: pageUrl.slice(0, 200) });
      emit(r); return r;
    }
    this.log.log('ALLOW', 'plugin ' + kind + ' approved', { url: pageUrl.slice(0, 200), job: jobId });

    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    // Output goes into the laboratory downloads dir; the template is relative
    // and the child runs with cwd=downloads (no path-escape possible).
    const relTpl = '%(title).80s [%(id)s].%(ext)s';

    const args = kind === 'video'
      ? ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4',
         '-o', relTpl, '--no-playlist', pageUrl]
      : ['--skip-download', '--write-auto-subs', '--write-subs',
         '--sub-langs', settings.all().subtitleLangs || 'en.*,pt.*',
         '-o', relTpl, '--no-playlist', pageUrl];

    const child = spawn(ytdlp, args, { windowsHide: true, cwd: DOWNLOADS_DIR });
    this.jobs.set(jobId, child);

    // Transcript jobs: after download, flatten the .vtt into clean .txt.
    if (kind === 'transcript') {
      child.on('close', (code) => {
        if (code !== 0) return;
        try {
          const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.vtt') &&
            f.includes(vid));
          for (const vtt of files) {
            const txtPath = path.join(DOWNLOADS_DIR, vtt.replace(/\.vtt$/, '') + '.txt');
            fs.writeFileSync(txtPath, vttToPlainText(path.join(DOWNLOADS_DIR, vtt)), 'utf8');
          }
          this.log.log('INFO', 'transcript converted to txt', { job: jobId });
        } catch (e) {
          this.log.log('ERROR', 'vtt->txt failed', { error: String(e).slice(0, 150), job: jobId });
        }
      });
    }

    emit({ jobId, kind, state: 'running', url: pageUrl });
    let lastPct = '';
    const onLine = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const m = line.match(/(\d+(?:\.\d+)?)%/);
        if (m && m[1] !== lastPct) {
          lastPct = m[1];
          emit({ jobId, kind, state: 'progress', pct: Number(m[1]) });
        }
        if (/has already been downloaded/.test(line)) {
          emit({ jobId, kind, state: 'done', note: 'already downloaded' });
        }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('error', (err) => {
      this.jobs.delete(jobId);
      emit({ jobId, kind, state: 'error', error: String(err.message || err).slice(0, 200) });
    });
    child.on('close', (code) => {
      this.jobs.delete(jobId);
      emit({ jobId, kind, state: code === 0 ? 'done' : 'error', code,
             error: code === 0 ? undefined : 'yt-dlp exited with code ' + code });
      this.log.log(code === 0 ? 'INFO' : 'ERROR', 'plugin ' + kind + ' finished', { code, job: jobId });
    });
    return { jobId, kind, state: 'started' };
  }

  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (j) { try { j.kill(); } catch {} this.jobs.delete(jobId); }
    return !!j;
  }
}

module.exports = { PluginRunner, extractVideoId, resolveYtDlp, DOWNLOADS_DIR };