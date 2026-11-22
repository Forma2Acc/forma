'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('formaLicense', {
  state: () => ipcRenderer.invoke('forma-license:state'),
  check: () => ipcRenderer.invoke('forma-license:check'),
  activate: (key) => ipcRenderer.invoke('forma-license:activate', key),
  ackMessage: (id) => ipcRenderer.invoke('forma-license:ackMessage', id),
  getKey: () => ipcRenderer.invoke('forma-license:getKey'),
  openSupport: () => ipcRenderer.invoke('forma-license:openSupport'),
  onState: (fn) => {
    const cb = (_event, value) => fn(value);
    ipcRenderer.on('forma-license:state', cb);
    return () => ipcRenderer.removeListener('forma-license:state', cb);
  },
});
