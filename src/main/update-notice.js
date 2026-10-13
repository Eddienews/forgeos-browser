/*
 * update-notice.js — tell the user when a newer release exists.
 *
 * The browser only says so; it never downloads or installs anything. See
 * engine/update-check.js for exactly what the single request carries, and
 * PRIVACY_MODEL.md for the user-facing description.
 */
'use strict';

const { app } = require('electron');
const settings = require('../engine/settings');
const updateCheck = require('../engine/update-check');

/**
 * @param {{logger: {log: Function}, sendToChrome: Function, openHumanTab: Function,
 *   isPackaged: boolean, isSmoke: boolean}} ctx
 */
function createUpdateNotice(ctx) {
  const log = ctx.logger;

  // The browser only tells the user a newer release exists; it never downloads
  // or installs one. See update-check.js for exactly what the request carries.
  let updateStatus = { enabled: true, available: false, latest: null, checkedAt: null, error: null, checking: false };
  let updateTimer = null;

  function publicUpdateStatus() {
    return { ...updateStatus, enabled: settings.all().checkForUpdates !== false, current: app.getVersion() };
  }

  async function runUpdateCheck({ manual = false } = {}) {
    if (!manual && settings.all().checkForUpdates === false) return publicUpdateStatus();
    if (updateStatus.checking) return publicUpdateStatus();
    updateStatus = { ...updateStatus, checking: true };
    ctx.sendToChrome('forge:update-status', publicUpdateStatus());
    const result = await updateCheck.checkForUpdate({ currentVersion: app.getVersion() });
    updateStatus = {
      ...updateStatus, checking: false, checkedAt: result.checkedAt, error: result.ok ? null : result.error,
      // A failed check keeps what an earlier successful one found.
      available: result.ok ? result.available : updateStatus.available,
      latest: result.ok ? result.latest : updateStatus.latest,
    };
    log.log(result.ok ? 'INFO' : 'WARN', 'update check', {
      outcome: result.ok ? (result.available ? 'newer release available' : 'up to date') : 'failed', manual,
    });
    ctx.sendToChrome('forge:update-status', publicUpdateStatus());
    return publicUpdateStatus();
  }

  /** Daily check for installed builds. Development and smoke runs never call out. */
  function scheduleUpdateChecks() {
    if (updateTimer || !ctx.isPackaged || ctx.isSmoke) return;
    setTimeout(() => runUpdateCheck().catch(() => {}), 20000).unref?.();
    updateTimer = setInterval(() => runUpdateCheck().catch(() => {}), updateCheck.CHECK_INTERVAL_MS);
    updateTimer.unref?.();
  }

  /** Open this project's release page for the newer version in a human tab. */
  function openUpdatePage() {
    const url = updateStatus.available ? updateCheck.releasePageUrl(updateStatus.latest) : null;
    if (!url) return false;
    ctx.openHumanTab(url);
    return true;
  }

  return { publicUpdateStatus, runUpdateCheck, scheduleUpdateChecks, openUpdatePage };
}

module.exports = { createUpdateNotice };
