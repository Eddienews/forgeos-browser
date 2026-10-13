/*
 * downloads.js — the in-session download registry and approval-gated plugin
 * jobs (YouTube video and transcript through a local yt-dlp).
 *
 * A plugin job starts only after the human approves it in a native dialog,
 * and only files that really exist inside the downloads directory are ever
 * reported back to the interface.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { PluginRunner } = require('../ext/plugins');
const { isExistingPathInside, isSafeToOpen, upsertDownload } = require('../engine/download-center');

/**
 * @param {{logger: {log: Function}, sendToChrome: Function, getDownloadDir: Function, chromeWin: object|null}} ctx
 *   chromeWin is read live from ctx on every call.
 */
function createDownloads(ctx) {
  const log = ctx.logger;
  const downloads = [];
  const plugins = new PluginRunner({ log });

  function pushDownload(record) {
    const saved = upsertDownload(downloads, {
      ...record, openable: isSafeToOpen(record.path || record.filename),
    }, 50);
    if (saved) ctx.sendToChrome('forge:download', saved);
    return saved;
  }

  function pluginDownloadRecord(event, context) {
    if (!event || !event.jobId) return null;
    const state = event.state === 'done' ? 'completed'
      : event.state === 'progress' ? 'running'
        : event.state;
    let sourceDomain = '';
    try { sourceDomain = new URL(context.url).hostname; } catch {}
    const safeFiles = Array.isArray(event.files)
      ? event.files.filter((file) => isExistingPathInside(ctx.getDownloadDir(), file))
      : [];
    const preferred = safeFiles.find((file) => context.kind === 'transcript' ? /\.txt$/i.test(file) : /\.mp4$/i.test(file))
      || safeFiles[0]
      || null;
    let size = null;
    if (preferred) {
      try { size = fs.statSync(preferred).size; } catch {}
    }
    return pushDownload({
      id: event.jobId,
      kind: 'plugin',
      pluginKind: event.kind || context.kind,
      filename: preferred ? path.basename(preferred) : context.label,
      source_domain: sourceDomain,
      url: context.url,
      state,
      pct: state === 'completed' ? 100 : event.pct,
      speed: event.speed || null,
      eta: event.eta || null,
      totalLabel: event.total || null,
      size,
      content_type: context.kind === 'transcript' ? 'text/plain' : 'video/mp4',
      path: preferred,
      files: safeFiles,
      error: event.error || null,
      warning: event.warning || null,
      cancellable: state === 'running',
      retryable: state === 'error' || state === 'cancelled',
      executable: false,
    });
  }

  async function runPluginJob(kind, pageUrl, label) {
    const context = {
      kind,
      url: pageUrl,
      label: label || (kind === 'transcript' ? 'YouTube transcript' : 'YouTube video'),
    };
    const result = await plugins.run(
      kind,
      pageUrl,
      async () => {
        if (!ctx.chromeWin) return { approved: false };
        const response = await dialog.showMessageBox(ctx.chromeWin, {
          type: 'question',
          title: 'ForgeOS Browser — approval required',
          message: `Plugin wants to ${kind === 'transcript' ? 'fetch a transcript' : 'download the video'} from this page`,
          detail: pageUrl,
          buttons: ['Deny', 'Approve'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        const approved = response.response === 1 && !response.checkboxChecked;
        log.log(approved ? 'ALLOW' : 'DENY', 'plugin approval ' + (approved ? 'granted' : 'denied'), { url: pageUrl.slice(0, 200), kind });
        return { approved };
      },
      (event) => {
        pluginDownloadRecord(event, context);
        ctx.sendToChrome('forge:plugin-event', event);
      }
    );
    if (result.state !== 'started') pluginDownloadRecord(result, context);
    return result;
  }

  return { downloads, plugins, pushDownload, runPluginJob };
}

module.exports = { createDownloads };
