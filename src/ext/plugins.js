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
         '--sub-langs', 'en.*,pt.*', '--convert-subs', 'srt',
         '-o', relTpl, '--no-playlist', pageUrl];

    const child = spawn(ytdlp, args, { windowsHide: true, cwd: DOWNLOADS_DIR });
    this.jobs.set(jobId, child);

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