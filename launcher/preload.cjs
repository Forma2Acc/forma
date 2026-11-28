'use strict';
const electron=require('electron');
const { contextBridge, ipcRenderer } = electron;

const listeners = new Set();
ipcRenderer.on('forma:progress', (_event, payload) => {
  for (const fn of listeners) {
    try { fn(payload); } catch (error) { console.error(error); }
  }
});

contextBridge.exposeInMainWorld('forma', {
  state: () => ipcRenderer.invoke('forma:state'),
  install: (options) => ipcRenderer.invoke('forma:install', options),
  codeInstall: (options) => ipcRenderer.invoke('forma:code-install', options),
  codeLaunch: () => ipcRenderer.invoke('forma:code-launch'),
  claudeInstall: (options) => ipcRenderer.invoke('forma:claude-install', options),
  claudeLaunch: () => ipcRenderer.invoke('forma:claude-launch'),
  claudeRestore: () => ipcRenderer.invoke('forma:claude-restore'),
  claudeState: () => ipcRenderer.invoke('forma:claude-state'),
  claudeKey: () => ipcRenderer.invoke('forma:claude-key'),
  claudeKeyInfo: () => ipcRenderer.invoke('forma:claude-key-info'),
  claudeActivate: (key) => ipcRenderer.invoke('forma:claude-activate', key),
  claudeOpen: (target) => ipcRenderer.invoke('forma:claude-open', target),
  claudeDownload: () => ipcRenderer.invoke('forma:claude-download'),
  updateAll: () => ipcRenderer.invoke('forma:update-all'),
  connections: () => ipcRenderer.invoke('forma:connections'),
  launch: () => ipcRenderer.invoke('forma:launch'),
  restore: () => ipcRenderer.invoke('forma:restore'),
  archive: () => ipcRenderer.invoke('forma:archive'),
  settings: (update) => ipcRenderer.invoke('forma:settings', update),
  healStatus: () => ipcRenderer.invoke('forma:heal-status'),
  healRun: () => ipcRenderer.invoke('forma:heal-run'),
  reveal: (target) => ipcRenderer.invoke('forma:reveal', target),
  help: (target) => ipcRenderer.invoke('forma:help', target),
  window: (action) => ipcRenderer.invoke('forma:window', action),
  onProgress: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
});


if (location.protocol === 'file:' && process.isMainFrame) {
  electron.contextBridge.exposeInMainWorld('formaLicense', {
    state: () => electron.ipcRenderer.invoke('forma-license:state'),
    check: () => electron.ipcRenderer.invoke('forma-license:check'),
    activate: (key) => electron.ipcRenderer.invoke('forma-license:activate', key),
    ackMessage: (id) => electron.ipcRenderer.invoke('forma-license:ackMessage', id),
    getKey: () => electron.ipcRenderer.invoke('forma-license:getKey'),
    openSupport: () => electron.ipcRenderer.invoke('forma-license:openSupport'),
    onState: (fn) => {
      const cb = (_event, value) => fn(value);
      electron.ipcRenderer.on('forma-license:state', cb);
      return () => electron.ipcRenderer.removeListener('forma-license:state', cb);
    },
  });
}

contextBridge.exposeInMainWorld('formaUpdates', {
  state: () => ipcRenderer.invoke('forma:update-state'),
  check: (options) => ipcRenderer.invoke('forma:update-check', options),
  download: () => ipcRenderer.invoke('forma:update-download'),
  install: () => ipcRenderer.invoke('forma:update-install'),
  onState: (fn) => {
    const cb = (_e, s) => fn(s);
    ipcRenderer.on('forma:update-state', cb);
    return () => ipcRenderer.removeListener('forma:update-state', cb);
  },
  onApplyError: (fn) => {
    const cb = (_e, err) => fn(err);
    ipcRenderer.on('forma:update-apply-error', cb);
    return () => ipcRenderer.removeListener('forma:update-apply-error', cb);
  },
});
