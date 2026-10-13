/*
 * page-output.js — print the current page, or save it as a PDF.
 *
 * Both act on the page the human is looking at, and only on a human action
 * (Ctrl+P or the menu). The PDF destination comes from a native save dialog.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

/**
 * @param {{logger: {log: Function}, activeTab: Function, chromeWin: object|null, activeTabId: number|null}} ctx
 *   chromeWin and activeTabId are read live from ctx on every call.
 */
function createPageOutput(ctx) {
  const log = ctx.logger;

  /** Open the system print dialog for the page the human is looking at. */
  function printActiveTab() {
    const t = ctx.activeTab();
    if (!t || t.closing || t.wc.isDestroyed()) return false;
    t.wc.print({ printBackground: true }, (ok, reason) => {
      if (!ok && reason && !/cancel/i.test(String(reason))) log.log('ERROR', 'print failed', { reason: String(reason).slice(0, 120) });
    });
    return true;
  }

  /** Save the current page as a PDF where the human chooses. */
  async function savePageAsPdf() {
    const t = ctx.activeTab();
    if (!t || t.closing || t.wc.isDestroyed() || !ctx.chromeWin || ctx.chromeWin.isDestroyed())
      return { ok: false, reason: 'No page to save.' };
    const id = t.id, url = t.wc.getURL();
    const base = String(t.title || 'page').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page';
    const choice = await dialog.showSaveDialog(ctx.chromeWin, {
      title: 'Save page as PDF',
      defaultPath: path.join(app.getPath('documents'), `${base}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    if (path.extname(choice.filePath).toLowerCase() !== '.pdf') return { ok: false, reason: 'The file name must end in .pdf.' };
    // The page shown when the dialog opened is the page that gets saved.
    if (ctx.activeTabId !== id || t.closing || t.wc.isDestroyed() || t.wc.getURL() !== url)
      return { ok: false, reason: 'The page changed; nothing was saved.' };
    try {
      const data = await t.wc.printToPDF({ printBackground: true });
      await fs.promises.writeFile(choice.filePath, data);
    } catch (error) {
      log.log('ERROR', 'save as PDF failed', { error: String(error).slice(0, 120) });
      return { ok: false, reason: 'Could not save the PDF.' };
    }
    log.log('INFO', 'page saved as PDF');
    return { ok: true, file: path.basename(choice.filePath) };
  }

  return { printActiveTab, savePageAsPdf };
}

module.exports = { createPageOutput };
