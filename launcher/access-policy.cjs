'use strict';
const SAFE_NATIVE_CHANNELS = new Set([
  'get_app_version',
  'get_platform_info',
  'get_language',
  'switch_ln',
  'switch_theme',
  'update_title_bar_for_system_theme',
  'webview-loaded',
  'open_external_link',
]);
const DEBUG_CHANNELS = new Set(['open_devtool', 'toggle_hidden_devtools']);

function collectRuntimeAnomalies({ packaged = true } = {}) {
  const anomalies = [];
  try {
    if (process.env.ELECTRON_RUN_AS_NODE) anomalies.push('run_as_node');
    if (process.env.NODE_OPTIONS) anomalies.push('node_options_set');
    if (process.env.NODE_EXTRA_CA_CERTS) anomalies.push('extra_ca_certs');
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') anomalies.push('tls_verify_disabled');
    if (process.env.VSCODE_INSPECTOR_OPTIONS) anomalies.push('vscode_inspector');
    if (process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES) anomalies.push('env_injection');
    if (process.env.ELECTRON_NO_ASAR) anomalies.push('electron_no_asar');
    if (process.env.SSLKEYLOGFILE) anomalies.push('sslkeylogfile_set');
    if (process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) {
      anomalies.push('proxy_env_set');
    }
    if (Object.keys(process.env).some((k) => k.toUpperCase().startsWith('FRIDA_'))) anomalies.push('frida_env');
    if (packaged) {
      const flags = [...process.execArgv, ...process.argv].join(' ');
      if (/--inspect(?:-brk|-wait)?|--remote-debugging-(?:port|pipe)|--allow-natives-syntax|--js-flags/i.test(flags)) {
        anomalies.push('debugger_flag');
      }
      if (/--disable-web-security|--ignore-certificate-errors|--proxy-server/i.test(flags)) {
        anomalies.push('chromium_security_bypass');
      }
      try {
        const inspector = require('node:inspector');
        if (typeof inspector.url === 'function' && inspector.url()) anomalies.push('debugger_detected');
      } catch {}
    }
  } catch {}
  return anomalies;
}

function attachWindowGuards(win, license, { packaged = true } = {}) {
  if (!win || win.isDestroyed?.() || !win.webContents) return;
  if (!packaged) return;

  const blockShortcut = (event, input) => {
    const key = String(input.key || '').toUpperCase();
    const devToolsShortcut =
      key === 'F12' ||
      ((input.control || input.meta) && input.shift && (key === 'I' || key === 'J' || key === 'C' || key === 'K'));
    if (devToolsShortcut) {
      event.preventDefault();
      license?.recordAnomaly?.('devtools_shortcut');
    }
  };
  win.webContents.on('before-input-event', blockShortcut);
  win.webContents.on('devtools-opened', () => {
    try { win.webContents.closeDevTools(); } catch {}
    license?.recordAnomaly?.('devtools_opened');
    license?.lockForSecurity?.('Developer tools are disabled in Forma.', ['CHK-098']);
    try { license?.check?.(); } catch {}
  });
}

function protectNativeIpc(ipcMain, license, { packaged = true } = {}) {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) =>
    original(channel, async (event, ...args) => {
      if (packaged && DEBUG_CHANNELS.has(channel)) {
        license.recordAnomaly?.('devtools_ipc_probe');
        throw Error('Developer tools are unavailable in this release.');
      }
      if (!channel.startsWith('forma-') && !SAFE_NATIVE_CHANNELS.has(channel)) license.requireActive();
      return handler(event, ...args);
    });
}

module.exports = { protectNativeIpc, collectRuntimeAnomalies, attachWindowGuards };
