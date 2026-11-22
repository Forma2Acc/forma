'use strict';
/**
 * Forma Claude — lock screen.
 *
 * A full-bleed WebContentsView pinned to the host window. Not a BrowserWindow:
 * the Claude host destroys extra windows, but a child view survives.
 *
 * The workspace stays hidden until the license is active, so no conversation is
 * ever painted behind a lock.
 */

const path = require('node:path');
const { ipcMain, shell, WebContentsView, BrowserView } = require('electron');

const CH = {
  device: 'forma:gate:device',
  status: 'forma:gate:status',
  activate: 'forma:gate:activate',
  proceed: 'forma:gate:proceed',
  openKey: 'forma:gate:open-key',
  quit: 'forma:gate:quit',
};

function createLockView(window, { preloadPath, gateFile }) {
  const options = {
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  };

  let view;
  let isWebContentsView = false;

  if (typeof WebContentsView === 'function') {
    view = new WebContentsView(options);
    isWebContentsView = true;
    window.contentView.addChildView(view);
  } else {
    // Electron < 30. Same behaviour, older API.
    view = new BrowserView(options);
    window.addBrowserView(view);
  }

  const fit = () => {
    if (!window || window.isDestroyed?.()) return;
    const [width, height] = window.getContentSize();
    const bounds = { x: 0, y: 0, width, height };
    try {
      if (isWebContentsView) view.setBounds(bounds);
      else window.setBrowserViewBounds(view, bounds);
    } catch {}
  };

  fit();
  window.on('resize', fit);

  view.setBackgroundColor?.('#0a0a0b');
  view.webContents.loadFile(gateFile);

  // The gate is not a page: no menu, no zoom, no navigation away.
  view.webContents.on('context-menu', (event) => event.preventDefault());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  return {
    view,
    fit,
    destroy() {
      window.off?.('resize', fit);
      try {
        if (isWebContentsView) window.contentView.removeChildView(view);
        else window.removeBrowserView(view);
      } catch {}
      try {
        view.webContents.close();
      } catch {}
    },
    setVisible(visible) {
      if (isWebContentsView) view.setVisible(visible);
      else view.setAutoResize?.({ width: true, height: true });
      if (visible) {
        fit();
        view.webContents.focus();
      }
    },
  };
}

/**
 * @param {object} opts
 * @param {import('electron').BrowserWindow} opts.window
 * @param {object} opts.license       FormaLicense instance
 * @param {string} opts.gateFile      absolute path to forma-gate.html
 * @param {string} opts.preloadPath   absolute path to forma-gate-preload.cjs
 * @param {Function} [opts.onUnlock]  called once access is active
 * @param {Function} [opts.onQuit]
 * @param {Function} [opts.log]
 */
function createLock({ window, license, gateFile, preloadPath, onUnlock, onQuit, log = () => {} }) {
  const surface = createLockView(window, { preloadPath, gateFile });
  let settled = false;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handlers = [];
  const on = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
    handlers.push({ channel, handle: true });
  };
  const onEvent = (channel, fn) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, fn);
    handlers.push({ channel, handle: false });
  };

  const cleanupHandlers = () => {
    for (const h of handlers.splice(0)) {
      try {
        if (h.handle) ipcMain.removeHandler(h.channel);
        else ipcMain.removeAllListeners(h.channel);
      } catch {}
    }
  };

  const close = (payload) => {
    if (settled) return;
    settled = true;
    cleanupHandlers();
    surface.destroy();
    resolveReady(payload);
  };

  const deny = (reason) => {
    if (settled) return;
    settled = true;
    cleanupHandlers();
    surface.destroy();
    rejectReady(new Error(reason));
  };

  on(CH.device, async () => license.device || '');
  on(CH.status, async () => license.snapshot());

  on(CH.activate, async (_event, payload) => {
    try {
      const result = await license.activate(payload?.key);
      const snap = result.state || license.snapshot();
      try {
        surface.view.webContents.send(CH.status, snap);
      } catch {}
      return result;
    } catch (err) {
      const message = String(err?.message || err);
      log('[gate] activate failed', { message });
      return { ok: false, message, state: license.snapshot() };
    }
  });

  onEvent(CH.proceed, () => {
    if (settled) return;
    const snap = license.snapshot();
    if (snap.status !== 'active') {
      try {
        surface.view.webContents.send(CH.status, snap);
      } catch {}
      return;
    }
    log('[gate] unlocked', { tier: snap.accessType });
    close(snap);
    try {
      onUnlock?.(snap);
    } catch (err) {
      log('[gate] onUnlock threw', { message: String(err?.message || err) });
    }
  });

  onEvent(CH.openKey, () => {
    const snap = license.snapshot();
    const url = `${snap.gatewayUrl}?installation=${encodeURIComponent(license.device || '')}`;
    shell.openExternal(url).catch(() => {});
  });

  onEvent(CH.quit, () => {
    log('[gate] quit from lock screen');
    cleanupHandlers();
    surface.destroy();
    try {
      onQuit?.();
    } catch {}
  });

  const pushStatus = (snap) => {
    try {
      surface.view.webContents.send(CH.status, snap);
    } catch {}
  };

  license.on('change', (snap) => {
    if (settled) return;
    pushStatus(snap);
    // Active on its own (saved key still valid) — release the lock without a click.
    if (snap.status === 'active') {
      const timer = setTimeout(() => {
        if (settled) return;
        log('[gate] auto-unlocked from stored key');
        close(snap);
        try {
          onUnlock?.(snap);
        } catch {}
      }, 600);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });

  // Show the current state immediately, without waiting for the first check.
  surface.view.webContents.once('did-finish-load', () => pushStatus(license.snapshot()));

  return {
    ready,
    surface,
    close,
    deny,
    pushStatus,
    destroy() {
      cleanupHandlers();
      surface.destroy();
    },
  };
}

module.exports = { createLock, createLockView, CH };
