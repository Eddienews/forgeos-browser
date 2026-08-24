/*
 * preload.js — contextIsolation bridge for the FORGE CHROME (toolbar) window.
 *
 * The page-webContents (tabs) get NO preload at all: rendered web content is
 * fully untrusted and has no bridge (Phase 17 security boundaries).
 * Only this chrome preload exposes the minimal `window.forge` API.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const FORGE_CHANNELS = [
  'forge:state', 'forge:agent-view', 'forge:log', 'forge:download', 'forge:security',
];

const api = {
  // actions (invoke = request/response)
  navigate: (url) => ipcRenderer.invoke('forge:navigate', url),
  back: () => ipcRenderer.invoke('forge:back'),
  forward: () => ipcRenderer.invoke('forge:forward'),
  reload: () => ipcRenderer.invoke('forge:reload'),
  newTab: (url) => ipcRenderer.invoke('forge:new-tab', url),
  closeTab: (id) => ipcRenderer.invoke('forge:close-tab', id),
  switchTab: (id) => ipcRenderer.invoke('forge:switch-tab', id),
  setMode: (mode) => ipcRenderer.invoke('forge:set-mode', mode),
  clearSession: () => ipcRenderer.invoke('forge:clear-session'),
  setForgetOnClose: (on) => ipcRenderer.invoke('forge:set-forget', on),
  togglePanels: () => ipcRenderer.invoke('forge:toggle-panel'),
  plugin: (kind) => ipcRenderer.invoke('forge:plugin', kind),
  pluginCancel: (jobId) => ipcRenderer.invoke('forge:plugin-cancel', jobId),
  openDownloads: () => ipcRenderer.invoke('forge:open-downloads'),
  settingsGet: () => ipcRenderer.invoke('forge:settings-get'),
  settingsSet: (patch) => ipcRenderer.invoke('forge:settings-set', patch),
  setMenuOpen: (open) => ipcRenderer.invoke('forge:set-menu-open', open),
  ytdlpStatus: () => ipcRenderer.invoke('forge:ytdlp-status'),
  bmList: () => ipcRenderer.invoke('forge:bm-list'),
  bmAdd: (item) => ipcRenderer.invoke('forge:bm-add', item),
  bmRemove: (id) => ipcRenderer.invoke('forge:bm-remove', id),
  bmIs: (url) => ipcRenderer.invoke('forge:bm-is', url),
  histList: () => ipcRenderer.invoke('forge:hist-list'),
  histRemove: (id) => ipcRenderer.invoke('forge:hist-remove', id),
  histClear: () => ipcRenderer.invoke('forge:hist-clear'),
  onPluginEvent: (cb) => ipcRenderer.on('forge:plugin-event', (_e, v) => cb(v)),
  openDevTools: (tabId) => ipcRenderer.invoke('forge:open-devtools', tabId),
  getAgentView: () => ipcRenderer.invoke('forge:agent-view'),
  requestAction: (action, details) => ipcRenderer.invoke('forge:request-action', action, details),
  getState: () => ipcRenderer.invoke('forge:get-state'),
  // agent integration surface (Phase 25)
  agent: {
    navigate: (url) => ipcRenderer.invoke('forge:navigate', url),
    readPage: () => ipcRenderer.invoke('forge:read-page'),
    getLinks: () => ipcRenderer.invoke('forge:get-links'),
    getAgentView: () => ipcRenderer.invoke('forge:agent-view'),
    securityStatus: () => ipcRenderer.invoke('forge:security-status'),
    click: (selector) => ipcRenderer.invoke('forge:click', selector),
    requestAction: (action, details) => ipcRenderer.invoke('forge:request-action', action, details),
  },
  // events (chrome renderer -> panels)
  onState: (cb) => ipcRenderer.on('forge:state', (_e, v) => cb(v)),
  onAgentView: (cb) => ipcRenderer.on('forge:agent-view', (_e, v) => cb(v)),
  onLog: (cb) => ipcRenderer.on('forge:log', (_e, v) => cb(v)),
  onDownload: (cb) => ipcRenderer.on('forge:download', (_e, v) => cb(v)),
  onSecurity: (cb) => ipcRenderer.on('forge:security', (_e, v) => cb(v)),
};

contextBridge.exposeInMainWorld('forge', Object.freeze(api));