'use strict';
/**
 * Forma Claude — lock screen preload.
 *
 * Sandboxed. The renderer gets four verbs and no filesystem.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forma', {
  license: {
    deviceId: () => ipcRenderer.invoke('forma:gate:device'),
    status: () => ipcRenderer.invoke('forma:gate:status'),
    activate: (payload) => ipcRenderer.invoke('forma:gate:activate', payload),
    proceed: () => ipcRenderer.send('forma:gate:proceed'),
    openKeyPage: () => ipcRenderer.send('forma:gate:open-key'),
    quit: () => ipcRenderer.send('forma:gate:quit'),
    onStatus: (fn) => {
      if (typeof fn !== 'function') return () => {};
      const handler = (_event, snap) => fn(snap);
      ipcRenderer.on('forma:gate:status', handler);
      return () => ipcRenderer.removeListener('forma:gate:status', handler);
    },
  },
});

// The gate is a control surface, not a page.
window.addEventListener('contextmenu', (event) => event.preventDefault(), true);
window.addEventListener('dragover', (event) => event.preventDefault(), true);
window.addEventListener('drop', (event) => event.preventDefault(), true);
window.addEventListener('keydown', (event) => {
  if (event.key === 'F12') event.preventDefault();
  if (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes((event.key || '').toLowerCase())) {
    event.preventDefault();
  }
  if (event.ctrlKey && (event.key || '').toLowerCase() === 'u') event.preventDefault();
}, true);
