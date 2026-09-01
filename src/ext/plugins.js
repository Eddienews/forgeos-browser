/*
 * plugins.js — approval-gated YouTube video and transcript jobs.
 *
 * Security contract:
 *  - Only the active tab's validated YouTube URL is accepted.
 *  - The human approval callback completes before tool discovery, directory
 *    creation, process launch, or any network request.
 *  - spawn() receives an argument array; no shell is involved.
 *  - Output is constrained to ForgeOS downloads/ and never auto-executed.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('../engine/settings');
const {
  buildYtDlpArgs,
  classifyYtDlpError,
  extractVideoId,
  resolveToolchain,
  resolveYtDlp,
  toolchainStatus,
  transcriptFiles,
  videoFiles,
  vttToPlainText,
} = require('./ytdlp-tools');

const IS_PACKAGED = __dirname.includes('app.asar');

function resolveDownloadsDir() {
  if (!IS_PACKAGED) return path.join(__dirname, '..', '..', 'downloads');
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, '.portable'))) return path.join(exeDir, 'downloads');
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'downloads');
  } catch {
    return path.join(exeDir, 'downloads');
  }
}

const DOWNLOADS_DIR = resolveDownloadsDir();

function safeLog(log, level, message, data) {
  try { log.log(level, message, data); } catch {}
}

function boundedOutput(lines) {
  return lines.slice(-40).join('\n').slice(-8000);
}

function childEnvironment(toolchain) {
  const toolDirs = [toolchain.ytdlp, toolchain.ffmpeg, toolchain.jsRuntime && toolchain.jsRuntime.path]
    .filter(Boolean)
    .map((file) => path.dirname(file));
  return {
    ...process.env,
    PATH: [...new Set([...toolDirs, process.env.PATH || ''])].join(path.delimiter),
  };
}

class PluginRunner {
  constructor(options = {}) {
    this.log = options.log || { log: () => {} };
    this.spawnImpl = options.spawnImpl || spawn;
    this.fs = options.fsImpl || fs;
    this.settings = options.settingsImpl || settings;
    this.downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
    this.resolveToolchain = options.resolveToolchainImpl || resolveToolchain;
    this.jobs = new Map();
    this.nextId = 1;
  }

  async run(kind, pageUrl, approve, emit = () => {}) {
    const jobId = 'job-' + this.nextId++;
    if (kind !== 'video' && kind !== 'transcript') {
      return { jobId, kind, state: 'error', error: 'Unsupported plugin action.' };
    }
    const videoId = extractVideoId(pageUrl);
    if (!videoId) {
      return { jobId, kind, state: 'error', error: 'Open a supported YouTube video, Short, or live-video page first.' };
    }

    // Nothing external happens before this call resolves affirmatively.
    const gate = await approve();
    if (!gate || !gate.approved) {
      safeLog(this.log, 'DENY', 'plugin action denied', { kind, videoId });
      return { jobId, kind, state: 'denied', reason: 'Human denied the action' };
    }

    const toolchain = this.resolveToolchain();
    if (!toolchain.ytdlp) {
      return {
        jobId, kind, state: 'error',
        error: 'yt-dlp is not installed. Install it, then restart ForgeOS Browser.',
      };
    }
    if (!toolchain.jsRuntime) {
      return {
        jobId, kind, state: 'error',
        error: 'YouTube requires Node 22+ or Deno 2.3+. Install one, then restart ForgeOS Browser.',
      };
    }
    if (kind === 'video' && !toolchain.ffmpeg) {
      return {
        jobId, kind, state: 'error',
        error: 'FFmpeg is required to merge video and audio. Install it, then restart ForgeOS Browser.',
      };
    }

    this.fs.mkdirSync(this.downloadsDir, { recursive: true });
    const transcriptBefore = new Map();
    if (kind === 'transcript') {
      for (const file of transcriptFiles(this.downloadsDir, videoId, this.fs)) {
        try { transcriptBefore.set(file, this.fs.statSync(file).mtimeMs); } catch {}
      }
    }
    const subtitleLangs = this.settings.all().subtitleLangs || 'en.*,pt.*';
    const args = buildYtDlpArgs(kind, pageUrl, {
      subtitleLangs,
      ffmpeg: toolchain.ffmpeg,
      jsRuntime: toolchain.jsRuntime,
    });

    let child;
    try {
      child = this.spawnImpl(toolchain.ytdlp, args, {
        windowsHide: true,
        cwd: this.downloadsDir,
        env: childEnvironment(toolchain),
        shell: false,
      });
    } catch (error) {
      return { jobId, kind, state: 'error', error: String(error.message || error).slice(0, 240) };
    }

    const job = { child, emit, kind, cancelled: false, finished: false };
    this.jobs.set(jobId, job);
    safeLog(this.log, 'ALLOW', 'plugin action started', { kind, videoId, job: jobId });
    emit({ jobId, kind, state: 'running', url: pageUrl });

    const stderrLines = [];
    const outputPaths = [];
    let lastPct = null;
    const onLine = (line, isErrorStream) => {
      const clean = line.trim();
      if (!clean) return;
      if (isErrorStream) stderrLines.push(clean);
      const marker = clean.match(/^FORGE_OUTPUT:(.+)$/);
      if (marker) outputPaths.push(marker[1].trim());
      const progress = clean.match(/FORGE_PROGRESS:\s*(\d+(?:\.\d+)?)%/) || clean.match(/\b(\d+(?:\.\d+)?)%/);
      if (progress) {
        const pct = Number(progress[1]);
        if (Number.isFinite(pct) && pct !== lastPct) {
          lastPct = pct;
          emit({ jobId, kind, state: 'progress', pct });
        }
      }
    };
    const consume = (stream, isErrorStream) => {
      if (!stream || typeof stream.on !== 'function') return;
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) onLine(line, isErrorStream);
      });
      stream.on('end', () => { if (pending) onLine(pending, isErrorStream); });
    };
    consume(child.stdout, false);
    consume(child.stderr, true);

    const finish = (event) => {
      if (job.finished) return;
      job.finished = true;
      this.jobs.delete(jobId);
      emit({ jobId, kind, ...event });
    };

    child.once('error', (error) => {
      finish({ state: 'error', error: `Unable to start yt-dlp: ${String(error.message || error).slice(0, 220)}` });
      safeLog(this.log, 'ERROR', 'plugin process failed to start', { kind, job: jobId });
    });
    child.once('close', (code, signal) => {
      if (job.finished) return;
      if (job.cancelled) {
        finish({ state: 'cancelled', signal: signal || null });
        safeLog(this.log, 'INFO', 'plugin action cancelled', { kind, job: jobId });
        return;
      }
      // yt-dlp can return non-zero when one requested translation fails after
      // it has already saved other valid captions. Preserve those useful
      // outputs and report the partial failure as a warning.
      if (kind === 'transcript') {
        try {
          const matchingFiles = transcriptFiles(this.downloadsDir, videoId, this.fs);
          const sourceFiles = matchingFiles.filter((file) => {
            if (!transcriptBefore.has(file)) return true;
            try { return this.fs.statSync(file).mtimeMs > transcriptBefore.get(file); } catch { return false; }
          });
          if (sourceFiles.length) {
            const files = sourceFiles.map((vttPath) => {
              const txtPath = vttPath.replace(/\.vtt$/i, '.txt');
              this.fs.writeFileSync(txtPath, vttToPlainText(vttPath, this.fs), 'utf8');
              return txtPath;
            });
            // VTT is an implementation detail. Remove only caption files
            // produced or updated by this job, after every TXT write succeeds.
            for (const vttPath of sourceFiles) this.fs.unlinkSync(vttPath);
            const warning = code === 0 ? undefined : classifyYtDlpError(
              boundedOutput(stderrLines), code, { kind, subtitleLangs }
            );
            finish({ state: 'done', code, files, warning });
            safeLog(this.log, code === 0 ? 'INFO' : 'WARN', 'transcript converted to text', {
              count: files.length, partial: code !== 0, job: jobId,
            });
            return;
          }
        } catch (error) {
          finish({ state: 'error', code, error: `Output processing failed: ${String(error.message || error).slice(0, 220)}` });
          safeLog(this.log, 'ERROR', 'plugin output processing failed', { kind, job: jobId });
          return;
        }
      }
      if (code !== 0) {
        const error = classifyYtDlpError(boundedOutput(stderrLines), code, { kind, subtitleLangs });
        finish({ state: 'error', code, error });
        safeLog(this.log, 'ERROR', 'plugin action failed', { kind, code, job: jobId });
        return;
      }

      try {
        if (kind === 'transcript') {
          finish({
            state: 'error', code,
            error: `No subtitles were produced for the selected languages (${subtitleLangs}). Try another language.`,
          });
          return;
        }

        const base = path.resolve(this.downloadsDir) + path.sep;
        const marked = outputPaths
          .map((file) => path.resolve(this.downloadsDir, file))
          .filter((file) => file.startsWith(base) && this.fs.existsSync(file));
        const files = [...new Set(marked.length ? marked : videoFiles(this.downloadsDir, videoId, this.fs))];
        if (!files.length) {
          finish({ state: 'error', code, error: 'yt-dlp exited successfully but no playable video file was found.' });
          return;
        }
        finish({ state: 'done', code, files });
        safeLog(this.log, 'INFO', 'video download completed', { count: files.length, job: jobId });
      } catch (error) {
        finish({ state: 'error', code, error: `Output processing failed: ${String(error.message || error).slice(0, 220)}` });
        safeLog(this.log, 'ERROR', 'plugin output processing failed', { kind, job: jobId });
      }
    });

    return { jobId, kind, state: 'started' };
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.cancelled = true;
    try { job.child.kill(); } catch {}
    return true;
  }
}

module.exports = {
  PluginRunner,
  DOWNLOADS_DIR,
  extractVideoId,
  resolveDownloadsDir,
  resolveYtDlp,
  toolchainStatus,
};
