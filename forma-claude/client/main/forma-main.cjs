'use strict';
/**
 * Forma Claude — composition root.
 *
 * claude-reset's main process calls this once, early:
 *
 *   const { installFormaClaude } = require('./forma-main.cjs');
 *   const forma = await installFormaClaude({
 *     app, ipcMain, safeStorage,
 *     rootDir,                 // %APPDATA%\Claude\forma-reset
 *     appRoot,                 // dir holding resources/app.asar
 *     getSessionKey: currentSessionKey,
 *     getAccounts: readAccounts,
 *     log,
 *   });
 *   const lock = forma.showLock(mainWindow);
 *   await lock.ready;          // resolves only when access is active
 *   workspace.setVisible(true);
 *
 * Everything gated goes through `forma.cap('plan', args)`, which refuses unless
 * the sealed module is open.
 */

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');

const { FormaLicense } = require('./forma-license.cjs');
const { createChatStore } = require('./forma-chat-store.cjs');
const { createProtectedGate } = require('./forma-protected.cjs');
const { FormaUpdater } = require('./forma-updater.cjs');
const { createLock } = require('./forma-lock.cjs');
const { attachNativeMenuSuppression, clearApplicationMenu } = require('./forma-ui-guard.cjs');

const CAP_ALLOWLIST = new Set([
  'windows',
  'windowState',
  'plan',
  'rankAccounts',
  'redact',
  'archiveBudget',
  'describe',
]);

const CH = {
  state: 'forma:license:state',
  activate: 'forma:license:activate',
  refresh: 'forma:license:refresh',
  deactivate: 'forma:license:deactivate',
  features: 'forma:license:features',
  openKey: 'forma:license:open-key',
  cap: 'forma:cap:call',
  archiveList: 'forma:archive:list',
  archiveGet: 'forma:archive:get',
  archiveCapture: 'forma:archive:capture',
  archiveDelete: 'forma:archive:delete',
  archiveStats: 'forma:archive:stats',
  updateStatus: 'forma:update:status',
  updateCheck: 'forma:update:check',
  updateApply: 'forma:update:apply',
  lockAgain: 'forma:license:lock',
};

async function installFormaClaude(options) {
  const {
    app,
    ipcMain,
    safeStorage,
    rootDir,
    appRoot,
    getSessionKey,
    getAccounts,
    log = () => {},
    apiUrl = process.env.FORMA_API_URL || 'https://forma-claude-production.up.railway.app',
    appVersion = app?.getVersion?.() || '2.0.0',
    publicKeyPem = process.env.FORMA_PUBLIC_KEY || null,
    gateFile = path.join(__dirname, '..', 'renderer', 'forma-gate.html'),
    gatePreload = path.join(__dirname, 'forma-gate-preload.cjs'),
  } = options || {};

  if (!app || !ipcMain || !rootDir) throw new Error('installFormaClaude needs app, ipcMain and rootDir');

  const startedAt = Date.now();

  // ── menus ────────────────────────────────────────────────────────────────
  clearApplicationMenu();
  attachNativeMenuSuppression();

  // ── license ──────────────────────────────────────────────────────────────
  const license = new FormaLicense({
    appData: app.getPath('appData'),
    safeStorage,
    apiUrl,
    appVersion,
  });

  if (publicKeyPem) {
    try {
      license.publicKey = require('node:crypto').createPublicKey(publicKeyPem);
    } catch {
      log('[license] FORMA_PUBLIC_KEY is not a valid key; falling back to fetch');
    }
  }

  try {
    await license.initialize();
  } catch (err) {
    log('[license] initialize failed', { message: String(err?.message || err) });
  }

  // ── protected module ─────────────────────────────────────────────────────
  const sysDir = path.join(app.getPath('appData'), 'FormaClaude', '.fc_sys');
  const moduleFile = path.join(sysDir, 'module.fsl');
  const gate = createProtectedGate({ file: moduleFile });

  let unlocking = null;

  async function unlockProtected() {
    if (gate.isUnlocked()) return true;
    if (unlocking) return unlocking;

    unlocking = (async () => {
      const lease = await license.fetchLease();
      if (!lease) {
        log('[protected] no lease; gated features stay off');
        return false;
      }
      if (!lease.sealedModule) {
        log('[protected] server has no sealed module; gated features stay off');
        return false;
      }
      try {
        await fs.promises.mkdir(sysDir, { recursive: true, mode: 0o700 });
        const blob = Buffer.from(lease.sealedModule, 'base64');
        const tmp = `${moduleFile}.tmp`;
        await fs.promises.writeFile(tmp, blob, { mode: 0o600 });
        await fs.promises.rename(tmp, moduleFile);
        gate.unlock({ leaseSecret: lease.leaseSecret, deviceId: license.device });
        log('[protected] module opened', { features: lease.features });
        return true;
      } catch (err) {
        gate.lock();
        log('[protected] could not open module', { message: String(err?.message || err) });
        return false;
      }
    })().finally(() => {
      unlocking = null;
    });

    return unlocking;
  }

  license.on('change', (snap) => {
    if (snap.status === 'active') unlockProtected().catch(() => {});
    else if (snap.status !== 'checking') gate.lock();
  });

  if (license.snapshot().status === 'active') await unlockProtected();

  // ── chat store ───────────────────────────────────────────────────────────
  const store = createChatStore({ rootDir, getSessionKey, getAccounts, log });

  // ── updater ──────────────────────────────────────────────────────────────
  let updater = null;
  try {
    const pem = publicKeyPem || (await readPinnedPublicKey(appRoot));
    if (pem) {
      updater = new FormaUpdater({
        apiUrl,
        currentVersion: appVersion,
        publicKeyPem: pem,
        userData: app.getPath('userData'),
        appRoot,
        onStatus: (status) => {
          try {
            for (const win of require('electron').BrowserWindow.getAllWindows()) {
              win.webContents.send(CH.updateStatus, status);
            }
          } catch {}
        },
      });
      await updater.init();
      const guard = await updater.guardBoot();
      if (guard.rolledBack) log('[update] rolled back to the previous bundle');
      updater.start();
      setTimeout(() => updater.confirmHealthy().catch(() => {}), 12_000).unref?.();
    } else {
      log('[update] no pinned public key; updater disabled');
    }
  } catch (err) {
    log('[update] disabled', { message: String(err?.message || err) });
  }

  // ── lock ─────────────────────────────────────────────────────────────────
  let activeLock = null;

  function showLock(window, { onUnlock, onQuit } = {}) {
    activeLock = createLock({
      window,
      license,
      gateFile,
      preloadPath: gatePreload,
      log,
      onUnlock: (snap) => {
        unlockProtected().catch(() => {});
        try {
          onUnlock?.(snap);
        } catch {}
      },
      onQuit: () => {
        try {
          onQuit?.();
        } catch {
          app.quit();
        }
      },
    });
    return activeLock;
  }

  // ── gated capability call ────────────────────────────────────────────────
  function cap(name, ...args) {
    if (!CAP_ALLOWLIST.has(name)) throw new Error(`capability ${name} is not allowed`);
    const lib = gate.get();
    if (!lib) throw new Error('Access is locked.');
    const fn = lib[name];
    if (typeof fn !== 'function') throw new Error(`capability ${name} is missing`);
    return fn(...args);
  }

  function features() {
    return license.features();
  }

  // ── IPC ──────────────────────────────────────────────────────────────────
  const registered = [];
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
    registered.push(channel);
  };

  handle(CH.state, async () => license.snapshot());
  handle(CH.activate, async (_e, payload) => license.activate(payload?.key));
  handle(CH.refresh, async () => license.refresh());
  handle(CH.deactivate, async () => {
    gate.lock();
    await license.clearKey();
    return license.set({ status: 'invalid', message: 'Enter your Forma Claude key to continue.' });
  });
  handle(CH.features, async () => features());
  handle(CH.openKey, async () => {
    const snap = license.snapshot();
    const base = snap.gatewayUrl || `${apiUrl}/get-key`;
    const url = `${base}?installation=${encodeURIComponent(license.device || '')}`;
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, url, error: String(err?.message || err) };
    }
  });

  handle(CH.cap, async (_e, payload) => {
    try {
      return { ok: true, value: cap(payload?.name, ...(payload?.args || [])) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  handle(CH.archiveList, async () => {
    const index = await store.list();
    return index.items || [];
  });
  handle(CH.archiveGet, async (_e, id) => store.get(id));
  handle(CH.archiveDelete, async (_e, id) => store.remove(id));
  handle(CH.archiveStats, async () => store.stats());
  handle(CH.archiveCapture, async () => {
    const result = await store.captureQuiet({ email: license.snapshot().licenseId || undefined });
    return result || { ok: false, reason: 'capture-failed' };
  });

  handle(CH.updateStatus, async () => updater?.state || { phase: 'disabled' });
  handle(CH.updateCheck, async () => (updater ? updater.check({ install: false }) : { ok: false, reason: 'disabled' }));
  handle(CH.updateApply, async () => {
    if (!updater) return { ok: false, reason: 'disabled' };
    const result = await updater.check({ install: true });
    if (!result.ok || !result.file) return result;
    await updater.apply(result.file);
    setTimeout(() => app.quit(), 1200);
    return { ok: true, version: result.update?.version };
  });

  // A revoked lease during a session must re-lock the app, not silently degrade.
  handle(CH.lockAgain, async () => {
    gate.lock();
    return license.refresh();
  });

  // ── quit capture ─────────────────────────────────────────────────────────
  let quitting = false;
  const onBeforeQuit = (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const done = () => {
      try {
        app.exit(0);
      } catch {}
    };
    store
      .captureOnQuit()
      .catch((err) => log('[archive] quit capture failed', { message: String(err?.message || err) }))
      .finally(done);
    // Belt and braces: never hang a quit on the network.
    const bail = setTimeout(done, 9000);
    bail.unref?.();
  };
  app.on('before-quit', onBeforeQuit);

  function dispose() {
    app.off('before-quit', onBeforeQuit);
    license.stop();
    updater?.stop();
    gate.lock();
    for (const channel of registered.splice(0)) {
      try {
        ipcMain.removeHandler(channel);
      } catch {}
    }
    try {
      activeLock?.destroy();
    } catch {}
    activeLock = null;
  }

  return {
    license,
    store,
    gate,
    updater,
    showLock,
    cap,
    features,
    unlockProtected,
    dispose,
    channels: CH,
    /** Milliseconds since install; the boot guard uses this for health. */
    uptime: () => Date.now() - startedAt,
    openExternal: (url) => shell.openExternal(url),
  };
}

/** Read the public key pinned next to the bundle, if the build shipped one. */
async function readPinnedPublicKey(appRoot) {
  const candidates = [
    path.join(appRoot, 'resources', 'forma-public.pem'),
    path.join(appRoot, 'forma-public.pem'),
  ];
  for (const file of candidates) {
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch {}
  }
  return null;
}

module.exports = { installFormaClaude, CH, CAP_ALLOWLIST };
