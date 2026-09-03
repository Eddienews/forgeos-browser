/*
 * ytdlp-tools.js — pure/testable support for the YouTube plugin runner.
 *
 * No function in this module starts a process or contacts the network. Tool
 * discovery only inspects explicit paths so the human approval gate can run
 * before yt-dlp, ffmpeg, or a JavaScript runtime is launched.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTPUT_TEMPLATE = '%(title).80s [%(id)s].%(ext)s';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);

function isExecutable(file, fsImpl = fs) {
  if (!file) return false;
  try {
    fsImpl.accessSync(file, fs.constants.X_OK);
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

function executableNames(name, platform) {
  if (name === 'yt-dlp') {
    if (platform === 'win32') return ['yt-dlp.exe', 'yt-dlp'];
    if (platform === 'darwin') return ['yt-dlp', 'yt-dlp_macos'];
    return ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_linux_aarch64'];
  }
  if (platform === 'win32') return [`${name}.exe`, name];
  return [name];
}

function candidateDirectories({ env, platform, homedir, execPath, resourcesPath }) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || '').split(delimiter).filter(Boolean);
  if (execPath) dirs.push(path.dirname(execPath));
  if (resourcesPath) dirs.push(resourcesPath, path.join(resourcesPath, 'bin'));
  dirs.push(path.join(homedir, '.local', 'bin'), path.join(homedir, 'bin'));

  if (platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  } else if (platform === 'linux') {
    dirs.push('/usr/local/bin', '/usr/bin', '/snap/bin');
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
    if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, 'scoop', 'shims'));
    if (env.ChocolateyInstall) dirs.push(path.join(env.ChocolateyInstall, 'bin'));
  }
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function resolveExecutable(name, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const fsImpl = options.fsImpl || fs;
  const override = options.override;
  if (override) return isExecutable(override, fsImpl) ? path.resolve(override) : null;

  const dirs = candidateDirectories({
    env,
    platform,
    homedir,
    execPath: options.execPath === undefined ? process.execPath : options.execPath,
    resourcesPath: options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath,
  });
  for (const dir of dirs) {
    for (const executable of executableNames(name, platform)) {
      const candidate = path.join(dir, executable);
      if (isExecutable(candidate, fsImpl)) return candidate;
    }
  }
  return null;
}

function resolveYtDlp(options = {}) {
  const env = options.env || process.env;
  return resolveExecutable('yt-dlp', {
    ...options,
    override: options.override === undefined ? env.FORGE_YTDLP : options.override,
  });
}

function resolveToolchain(options = {}) {
  const env = options.env || process.env;
  const common = { ...options, override: undefined };
  const ytdlp = resolveYtDlp(options);
  const ffmpeg = resolveExecutable('ffmpeg', {
    ...common,
    override: options.ffmpegOverride === undefined ? env.FORGE_FFMPEG : options.ffmpegOverride,
  });
  const runtimes = [
    ['deno', resolveExecutable('deno', common)],
    ['node', resolveExecutable('node', common)],
    ['quickjs', resolveExecutable('qjs', common)],
  ];
  const runtime = runtimes.find((entry) => !!entry[1]) || null;
  return {
    ytdlp,
    ffmpeg,
    jsRuntime: runtime ? { name: runtime[0], path: runtime[1] } : null,
  };
}

function installHint(platform = process.platform) {
  if (platform === 'darwin') return 'Install with Homebrew: brew install yt-dlp ffmpeg';
  if (platform === 'win32') return 'Install yt-dlp, FFmpeg, and Node 22+; then restart ForgeOS Browser.';
  return 'Install yt-dlp, FFmpeg, and Node 22+ (or Deno 2.3+); then restart ForgeOS Browser.';
}

function toolchainStatus(options = {}) {
  const tools = resolveToolchain(options);
  const missing = [];
  if (!tools.ytdlp) missing.push('yt-dlp');
  if (!tools.ffmpeg) missing.push('FFmpeg');
  if (!tools.jsRuntime) missing.push('Node 22+ or Deno 2.3+');
  return {
    found: !!tools.ytdlp,
    ready: missing.length === 0,
    path: tools.ytdlp,
    ffmpeg: !!tools.ffmpeg,
    jsRuntime: tools.jsRuntime ? tools.jsRuntime.name : null,
    missing,
    hint: missing.length ? installHint(options.platform || process.platform) : '',
  };
}

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
    let id = null;
    if (isYoutube) {
      id = parsed.searchParams.get('v');
      if (!id) {
        const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,20})(?:\/|$)/);
        if (match) id = match[1];
      }
    } else if (host === 'youtu.be') {
      const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{6,20})(?:\/|$)/);
      if (match) id = match[1];
    }
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function normalizeSubtitleLanguages(value) {
  const langs = String(value || '').trim();
  return langs && langs.length <= 80 && /^[A-Za-z0-9.*,_-]+$/.test(langs)
    ? langs
    : 'en.*,pt.*';
}

function cleanProgressField(value) {
  const field = String(value || '').trim();
  return field && !/^(?:n\/a|na|none|unknown)$/i.test(field) ? field : null;
}

function parseYtDlpProgress(line) {
  const match = String(line || '').trim().match(
    /^FORGE_PROGRESS:\s*(\d+(?:\.\d+)?)%?(?:\|([^|]*)\|([^|]*)\|([^|]*))?$/
  );
  if (!match) return null;
  const pct = Number(match[1]);
  if (!Number.isFinite(pct)) return null;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    speed: cleanProgressField(match[2]),
    eta: cleanProgressField(match[3]),
    total: cleanProgressField(match[4]),
  };
}

function buildYtDlpArgs(kind, pageUrl, options = {}) {
  if (kind !== 'video' && kind !== 'transcript') throw new Error('Unsupported plugin kind');
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-simulate',
    '--newline',
    '--color', 'never',
    '--progress-template', 'download:FORGE_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s',
    '--output', OUTPUT_TEMPLATE,
  ];
  if (options.jsRuntime && options.jsRuntime.path) {
    args.push('--js-runtimes', `${options.jsRuntime.name}:${options.jsRuntime.path}`);
  }
  if (options.ffmpeg) args.push('--ffmpeg-location', options.ffmpeg);

  if (kind === 'video') {
    args.push(
      // An MP4 container alone is not enough for Apple playback. Never fall
      // back to AV1/VP9 or Opus inside MP4: QuickTime can open that file but
      // may play audio without video. Fail clearly if H.264/AAC is unavailable.
      '--format', 'bv[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1][acodec^=mp4a]',
      '--merge-output-format', 'mp4',
      '--print', 'after_move:FORGE_OUTPUT:%(filepath)s',
    );
  } else {
    args.push(
      '--skip-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs', normalizeSubtitleLanguages(options.subtitleLangs),
      '--sub-format', 'vtt/best',
    );
    if (options.ffmpeg) args.push('--convert-subs', 'vtt');
  }
  args.push('--', pageUrl);
  return args;
}

function stripSubtitleMarkup(line) {
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\[\s*[_—-]*\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function vttToPlainTextContent(raw) {
  const cues = [];
  let cue = [];
  let skipBlock = false;
  const flush = () => {
    if (cue.length) cues.push([...new Set(cue)].join(' '));
    cue = [];
  };
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { flush(); skipBlock = false; continue; }
    if (/^(WEBVTT|Kind:|Language:)/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) { skipBlock = true; continue; }
    if (skipBlock || /^\d+$/.test(line) || line.includes('-->')) continue;
    const clean = stripSubtitleMarkup(line);
    if (clean) cue.push(clean);
  }
  flush();

  const words = [];
  for (const text of cues) {
    const incoming = text.split(/\s+/).filter(Boolean);
    let overlap = 0;
    const max = Math.min(words.length, incoming.length);
    for (let size = max; size > 0; size--) {
      const left = words.slice(words.length - size).map((word) => word.toLowerCase());
      const right = incoming.slice(0, size).map((word) => word.toLowerCase());
      if (left.every((word, index) => word === right[index])) { overlap = size; break; }
    }
    words.push(...incoming.slice(overlap));
  }
  return words.join(' ').replace(/\s+/g, ' ').trim() + '\n';
}

function vttToPlainText(vttPath, fsImpl = fs) {
  return vttToPlainTextContent(fsImpl.readFileSync(vttPath, 'utf8'));
}

function filesForVideo(downloadsDir, videoId, extensions, fsImpl = fs) {
  const exactId = `[${videoId}]`;
  try {
    return fsImpl.readdirSync(downloadsDir)
      .filter((name) => name.includes(exactId) && extensions.has(path.extname(name).toLowerCase()))
      .map((name) => path.join(downloadsDir, name));
  } catch {
    return [];
  }
}

function transcriptFiles(downloadsDir, videoId, fsImpl = fs) {
  return filesForVideo(downloadsDir, videoId, new Set(['.vtt']), fsImpl);
}

function videoFiles(downloadsDir, videoId, fsImpl = fs) {
  return filesForVideo(downloadsDir, videoId, VIDEO_EXTENSIONS, fsImpl);
}

function classifyYtDlpError(output, code, context = {}) {
  const text = String(output || '').replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  const lower = text.toLowerCase();
  if (/no subtitles|no automatic captions|requested subtitles.*not available/.test(lower)) {
    return `No subtitles are available for the selected languages (${context.subtitleLangs || 'configured languages'}).`;
  }
  if (/sign in to confirm|login required|age.?restricted|cookies-from-browser/.test(lower)) {
    return 'YouTube requires sign-in, age verification, or a bot check for this video. ForgeOS does not export browser credentials.';
  }
  if (/no supported javascript runtime|javascript runtime.*not found|unsupported.*node/.test(lower)) {
    return 'YouTube requires Node 22+ or Deno 2.3+. Install a supported runtime and restart ForgeOS Browser.';
  }
  if (/ffmpeg.*not found|ffprobe.*not found/.test(lower)) {
    return 'FFmpeg is required to merge or convert this download. Install FFmpeg and restart ForgeOS Browser.';
  }
  if (/requested format is not available|no video formats found/.test(lower)) {
    return 'This video does not offer a QuickTime-compatible H.264/AAC format at 1080p or below.';
  }
  if (/unable to download|network is unreachable|timed? out|temporary failure|connection refused/.test(lower)) {
    return 'The download failed because YouTube or the network could not be reached. Check the connection and try again.';
  }
  if (/http error 429|too many requests/.test(lower)) {
    return 'YouTube temporarily rate-limited this connection. Wait and try again later.';
  }
  const errorLine = text.split(/\r?\n/).reverse().find((line) => /^\s*error:/i.test(line));
  if (errorLine) return errorLine.replace(/^\s*error:\s*/i, '').trim().slice(0, 280);
  return `yt-dlp exited with code ${code == null ? 'unknown' : code}.`;
}

module.exports = {
  OUTPUT_TEMPLATE,
  VIDEO_EXTENSIONS,
  buildYtDlpArgs,
  classifyYtDlpError,
  extractVideoId,
  installHint,
  isExecutable,
  normalizeSubtitleLanguages,
  parseYtDlpProgress,
  resolveExecutable,
  resolveToolchain,
  resolveYtDlp,
  toolchainStatus,
  transcriptFiles,
  videoFiles,
  vttToPlainText,
  vttToPlainTextContent,
};
