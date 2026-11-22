'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { LicenseClient } = require('./license-client.cjs');
const { attachWindowGuards } = require('./access-policy.cjs');

module.exports = function (electron, config, options = {}) {
  const { app, ipcMain, shell, BrowserWindow } = electron;
  const license = new LicenseClient({
    root: path.join(app.getPath('appData'), 'FormaAccess'),
    safeStorage: require('./windows-vault.cjs'),
    config,
    getTelemetry: options.getTelemetry || null,
  });
  const canonical = (file) => (process.platform === 'linux' ? path.resolve(file) : path.resolve(file).toLowerCase());
  const gatePath = path.join(__dirname, 'license-gate.html');
  const trustedFiles = new Set(
    [
      gatePath,
      path.join(__dirname, 'renderer/index.html'),
      path.join(__dirname, '../renderer/index.html'),
      path.join(app.getAppPath(), 'renderer/index.html'),
      path.join(app.getAppPath(), 'out/renderer/index.html'),
    ].map(canonical),
  );
  const local = (event) => {
    const url = event.senderFrame?.url || event.sender.getURL();
    if (!url.startsWith('file:') || event.sender.hostWebContents || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) {
      throw Error('Unauthorized license request.');
    }
    let file;
    try {
      file = canonical(fileURLToPath(url));
    } catch {
      throw Error('Unauthorized license request.');
    }
    if (!trustedFiles.has(file)) throw Error('Unauthorized license request.');
  };
  for (const [name, fn] of Object.entries({
    state: () => license.snapshot(),
    check: () => license.check(),
    activate: (key) => license.activate(key),
    ackMessage: (id) => license.ackMessage(id),
    getKey: async () => {
      await shell.openExternal(await license.keyUrl());
      return true;
    },
    openSupport: async () => {
      await shell.openExternal('https://discord.gg/MqwFSTEdkF');
      return true;
    },
  })) {
    ipcMain.handle('forma-license:' + name, async (event, ...args) => {
      local(event);
      return fn(...args);
    });
  }
  let gate = null,
    creatingGate = false,
    quitting = false;
  const protectedWindows = new Map();
  function showGate() {
    if (quitting || !app.isReady() || license.snapshot().status === 'active') return;
    if (!gate || gate.isDestroyed()) {
      creatingGate = true;
      try {
        gate = new BrowserWindow({
          width: 760,
          height: 720,
          minWidth: 600,
          minHeight: 640,
          show: false,
          title: 'Forma Access',
          backgroundColor: '#090a0d',
          autoHideMenuBar: true,
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#090a0d', symbolColor: '#e8eaef', height: 42 },
          webPreferences: {
            preload: path.join(__dirname, 'license-preload.cjs'),
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false,
            spellcheck: false,
          },
        });
        gate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        gate.webContents.on('will-navigate', (event) => event.preventDefault());
        gate.once('ready-to-show', () => {
          if (license.snapshot().status !== 'active') {
            gate?.show();
            gate?.focus();
          }
        });
        gate.on('close', () => {
          if (!quitting && license.snapshot().status !== 'active') app.quit();
        });
        gate.on('closed', () => {
          gate = null;
        });
        gate.loadFile(gatePath);
      } finally {
        creatingGate = false;
      }
    } else {
      gate.show();
      gate.focus();
    }
  }
  function protectWindow(win) {
    attachWindowGuards(win, license, { packaged: app.isPackaged });
    if (creatingGate) return;
    protectedWindows.set(win, { restore: false });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const enforce = (fromReady = false) => {
      if (license.snapshot().status !== 'active' && !win.isDestroyed()) {
        const record = protectedWindows.get(win);
        if (record && (win.isVisible() || fromReady)) record.restore = true;
        win.hide();
        showGate();
      }
    };
    win.on('show', () => enforce(false));
    win.once('ready-to-show', () => enforce(true));
    win.on('closed', () => protectedWindows.delete(win));
  }
  app.on('browser-window-created', (_event, win) => protectWindow(win));
  license.on('change', (state) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('forma-license:state', state);
    if (state.status === 'active') {
      const unlockedGate = gate;
      if (unlockedGate && !unlockedGate.isDestroyed()) {
        setTimeout(() => {
          if (license.snapshot().status === 'active' && !unlockedGate.isDestroyed()) unlockedGate.destroy();
        }, 120).unref();
      }
      for (const [win, record] of protectedWindows) {
        if (!win.isDestroyed() && record.restore) {
          record.restore = false;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      }
    } else {
      for (const [win, record] of protectedWindows) {
        if (!win.isDestroyed() && win.isVisible()) {
          record.restore = true;
          win.hide();
        }
      }
      if (app.isPackaged) showGate();
    }
  });
  app
    .whenReady()
    .then(() => license.initialize())
    .catch(() => license.set({ status: 'error', message: 'Access could not be initialized. Restart Forma and try again.' }));
  app.on('before-quit', () => {
    quitting = true;
    license.stop();
  });
  return license;
};
