'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const rawBootFs = require('original-fs');

const IS_LINUX = process.platform === 'linux';
/**
 * Packaged builds ship the payload in resources/payload. A dev run used to fall
 * back to the repository root, where no Forma.asar exists, so every dev launch
 * reported "Installation package was modified". Use the real payload folder.
 */
function devPayloadDir() {
  const candidates = [
    process.env.FORMA_PAYLOAD_DIR,
    path.join(__dirname, 'payload'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'forma', 'resources', 'payload'),
    path.resolve(__dirname, '..', '..'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (require('node:fs').existsSync(path.join(candidate, 'Forma.asar'))) return candidate;
    } catch {}
  }
  return path.resolve(__dirname, '..', '..');
}
const BOOT_PROJECT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'payload') : devPayloadDir();

if (process.argv.includes('--forma-qwen')) {
  app.setName('Qwen');
  if (IS_LINUX) {
    try { app.setDesktopName?.('forma.desktop'); } catch {}
  }
  const qwenAsar = path.join(BOOT_PROJECT_DIR, 'Forma.asar');
  try {
    const manifest = require('./payload-manifest.json');
    const actual = crypto.createHash('sha256').update(rawBootFs.readFileSync(qwenAsar)).digest('hex');
    if (manifest['Forma.asar'] && actual !== manifest['Forma.asar']) {
      throw new Error('Forma.asar checksum mismatch.');
    }
  } catch (err) {
    console.error('[Forma-Qwen] Integrity check failed:', err?.message || err);
    app.exit(1);
  }
  require(path.join(qwenAsar, 'out', 'main', 'index.js'));
  return;
}

app.setName('Forma');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');

const RUNTIME_DIR = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', 'runtime');
const LAUNCHER_DIR = path.dirname(RUNTIME_DIR);
const PROJECT_DIR = BOOT_PROJECT_DIR;
const releaseConfig = require('./license-config.json');
const { collectRuntimeAnomalies } = require('./access-policy.cjs');
const { SecurityShield, writeLauncherAnchor } = require('./security-shield.cjs');
const launcherVault = require('./windows-vault.cjs');
const { SignedUpdater } = require('./update-client.cjs');
const { installQwen } = require('./qwen-installer.cjs');

const ORIGINAL_SHA = 'ebc1b0e1cbdee2723bd52c7e869292d624c67f1d0b2be3bc5704e2b6d2a1552f';
const QWEN_DATA = IS_LINUX
  ? path.join(app.getPath('appData'), 'Qwen')
  : path.join(process.env.APPDATA || app.getPath('appData'), 'Qwen');
const QWEN_DIR = IS_LINUX ? QWEN_DATA : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Qwen');
const QWEN_EXE = IS_LINUX ? (process.env.APPIMAGE || process.execPath) : path.join(QWEN_DIR, 'Qwen.exe');
const QWEN_ASAR = IS_LINUX ? path.join(PROJECT_DIR, 'Forma.asar') : path.join(QWEN_DIR, 'resources', 'app.asar');
const CODE_DIR = IS_LINUX ? '' : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Forma Code');
const CODE_EXE = IS_LINUX ? '' : path.join(CODE_DIR, 'Forma Code.exe');
const CODE_ASAR = IS_LINUX ? '' : path.join(CODE_DIR, 'resources', 'app.asar');
const CLAUDE_API = 'https://forma-claude-production.up.railway.app';
const CLAUDE_KEY_URL = 'https://forma-core-production.up.railway.app/get-key/claude';
const CLAUDE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/4ZSXnxrrdJ3mjEByE/t516baBBaTDa0i3C7/hQZBSA=\n-----END PUBLIC KEY-----\n';
const CLAUDE_DIR = IS_LINUX ? '' : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'FormaClaude');
const CLAUDE_DIR_LEGACY = IS_LINUX ? '' : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ClaudeForma');
const CLAUDE_ARCHIVE = path.join(process.env.APPDATA || app.getPath('appData'), 'Claude', 'forma-reset', 'archive');
const CLAUDE_SYS = path.join(process.env.APPDATA || app.getPath('appData'), 'FormaClaude', '.fc_sys');
const CLAUDE_EXE_NAME = IS_LINUX ? 'claude' : 'claude.exe';
const HISTORY_FILE = path.join(QWEN_DATA, 'forma', 'native-history.json');
const ORIGINAL_EXE_BACKUP = path.join(app.getPath('userData'), 'qwen-backups', 'Original-Qwen.exe');

const DEFAULT_SETTINGS = {
  acrylic: true,
  motion: true,
  launchAfterInstall: true,
  hideOnLaunch: false,
  autoUpdateApps: true,
  rebuild: false
};

let window = null;
let busy = false;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = '';
const hashCache = new Map();

let shield = null;

async function collectLauncherTelemetry(opts = {}) {
  const anomalies = collectRuntimeAnomalies({ packaged: app.isPackaged });
  let qwenVersion = null;
  let formaCodeVersion = null;
  let formaCodeInstalled = false;
  try { qwenVersion = (await installedQwenPackage())?.version || null; } catch {}
  try {
    formaCodeInstalled = !IS_LINUX && exists(CODE_EXE);
    if (formaCodeInstalled && exists(CODE_ASAR)) formaCodeVersion = (await installedAsarPackage(CODE_ASAR))?.version || null;
  } catch {}
  const [asarHash, exeHash, launcherAsarHash] = await Promise.all([
    hashFile(path.join(PROJECT_DIR, 'Forma.asar')),
    hashFile(path.join(PROJECT_DIR, 'Qwen.exe')),
    app.isPackaged ? hashFile(path.join(process.resourcesPath, 'app.asar')) : Promise.resolve(null),
  ]);
  try {
    const manifest = require('./payload-manifest.json');
    if (asarHash && manifest['Forma.asar'] && asarHash !== manifest['Forma.asar']) anomalies.push('asar_mismatch');
    if (!IS_LINUX && exeHash && manifest['Qwen.exe'] && exeHash !== manifest['Qwen.exe']) anomalies.push('exe_mismatch');
  } catch {}
  let audit = null;
  try {
    if (shield) {
      if (opts.fast && shield.lastAudit && Date.now() - (shield.lastAudit.checkedAt || 0) < 60000) {
        audit = shield.lastAudit;
      } else {
        audit = await shield.runAudit({ forceRescan: false, fast: !!opts.fast });
      }
    }
  } catch {}
  const mergedAnomalies = [...new Set([...anomalies, ...(audit?.anomalies || [])])];
  return {
    appVersion: app.getVersion(),
    qwenVersion,
    formaCodeVersion,
    formaCodeInstalled,
    installedApps: { formaLauncher: app.getVersion(), qwenDesktop: qwenVersion, formaCode: formaCodeVersion },
    platform: process.platform,
    arch: process.arch,
    computerName: (() => { try { return String(os.hostname() || '').slice(0, 64) || null; } catch { return null; } })(),
    osUser: (() => { try { return String(os.userInfo()?.username || '').slice(0, 64) || null; } catch { return null; } })(),
    osRelease: (() => { try { return String(os.release() || '').slice(0, 48) || null; } catch { return null; } })(),
    cpuModel: (() => { try { return String(os.cpus()?.[0]?.model || '').slice(0, 80) || null; } catch { return null; } })(),
    asarHash,
    exeHash,
    launcherAsarHash,
    fusesOk: audit ? audit.fusesOk : false,
    devToolsBlocked: audit ? audit.devToolsBlocked : false,
    launcherOk: audit ? audit.launcherOk : false,
    nativeOk: audit ? audit.nativeOk : false,
    shield: audit
      ? {
          total: audit.total,
          passed: audit.passed,
          blocked: audit.blocked,
          launcherOk: audit.launcherOk,
          nativeOk: audit.nativeOk,
          criticalFailed: audit.criticalFailed.map((x) => x.id),
          highFailed: audit.highFailed.map((x) => x.id),
          mediumFailed: (audit.mediumFailed || []).map((x) => x.id),
        }
      : null,
    anomalies: mergedAnomalies,
  };
}

const license = require('./license-electron.cjs')(require('electron'), releaseConfig, { getTelemetry: collectLauncherTelemetry });
shield = new SecurityShield({
  role: 'launcher',
  packaged: app.isPackaged,
  enforce: false,
  app,
  config: releaseConfig,
  payloadManifest: (() => { try { return require('./payload-manifest.json'); } catch { return null; } })(),
  license,
  vault: launcherVault,
  accessRoot: path.join(app.getPath('appData'), 'FormaAccess'),
  moduleDir: __dirname,
  ipcValidatorActive: true,
  windowGuardsActive: app.isPackaged,
  onAutoBlock: async () => {
    try { await license.heartbeat(); } catch {}
  },
});
shield.startWatchdog(15000);
const { newer } = require('./update-client.cjs');
const updater = new SignedUpdater({app,config:releaseConfig,root:path.join(app.getPath('userData'),'updates'),restart:app.isPackaged&&!IS_LINUX?{path:process.execPath,args:['--forma-apply-update']}:null});
let autoInstallTimer = null;
let autoInstallScheduled = false;
const updateAttemptsFile = path.join(app.getPath('userData'), 'update-attempts.json');
let updateAttempts = {};
try { updateAttempts = JSON.parse(fs.readFileSync(updateAttemptsFile, 'utf8')) || {}; } catch { updateAttempts = {}; }
function updateAttempted(version) {
  return !!(version && updateAttempts[version] && updateAttempts[version].at);
}
function markUpdateAttempt(version) {
  if (!version) return;
  updateAttempts[version] = { at: Date.now() };
  try { fs.writeFileSync(updateAttemptsFile, JSON.stringify(updateAttempts, null, 2)); } catch {}
}
function autoApplyState(state) {
  return state.status === 'ready'
    && app.isPackaged
    && process.env.FORMA_DISABLE_AUTO_INSTALL !== '1'
    && !updateAttempted(state.version);
}
function scheduleAutoInstall() {
  if (!app.isPackaged || process.env.FORMA_DISABLE_AUTO_INSTALL === '1' || autoInstallScheduled) return;
  const state = updater.state();
  // One automatic attempt per version. If the installer cannot replace the
  // running build, the app offers a manual install instead of restarting
  // itself forever.
  if (!autoApplyState(state)) return;
  autoInstallScheduled = true;
  if (window && !window.isDestroyed()) {
    window.webContents.send('forma:update-state', { ...state, autoApplying: true, message: 'Update verified - restarting Forma automatically...' });
  }
  const tick = () => {
    const current = updater.state();
    if (current.status !== 'ready') { autoInstallScheduled = false; return; }
    if (busy) { autoInstallTimer = setTimeout(tick, 1000); autoInstallTimer.unref?.(); return; }
    if (updateAttempted(current.version)) { autoInstallScheduled = false; return; }
    markUpdateAttempt(current.version);
    updater.install().catch(() => { autoInstallScheduled = false; });
  };
  autoInstallTimer = setTimeout(tick, 1200);
  autoInstallTimer.unref?.();
}
updater.on('change',state=>{
  const payload = autoApplyState(state)
    ? { ...state, autoApplying: true, message: 'Update verified - restarting Forma automatically...' }
    : state;
  if(window&&!window.isDestroyed())window.webContents.send('forma:update-state',payload);
  if (state.status === 'ready') scheduleAutoInstall();
});
license.on('change', s => {
  const ver = s?.policy?.latestRelease?.version;
  if (ver && newer(ver, app.getVersion()) && ['idle', 'current', 'error'].includes(updater.state().status)) {
    updater.check({ autoDownload: true }).catch(() => {});
  }
});
license.on('change',state=>{if(state.status==='update-required')updater.check({ autoDownload: true }).catch(()=>{})});

if (!app.isPackaged && process.argv.includes('--forma-debug')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9242');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

app.setName('Forma');
app.setAppUserModelId('ai.forma.launcher');
Menu.setApplicationMenu(null);

let applyUpdateRequested=process.argv.includes('--forma-apply-update');
let single = app.requestSingleInstanceLock();
if (!single && applyUpdateRequested) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 8 && !single; i++) {
    Atomics.wait(sleeper, 0, 0, 200);
    single = app.requestSingleInstanceLock();
  }
}
let applyUpdateTimer=null;
async function applyRequestedUpdate(){
  if(!applyUpdateRequested||!window)return;
  if(busy){clearTimeout(applyUpdateTimer);applyUpdateTimer=setTimeout(()=>applyRequestedUpdate().catch(()=>{}),400);return;}
  if(license.snapshot().status!=='active'){
    if(license.snapshot().status==='checking'){
      try{await license.check(true)}catch{}
    }
    if(license.snapshot().status!=='active')return;
  }
  applyUpdateRequested=false;
  busy=true;
  try{
    if(!window.isDestroyed()){
      if(window.isMinimized())window.restore();
      window.show();
      window.focus();
    }
    const result=await installPipeline({launch:true});
    if(!result.ok&&window&&!window.isDestroyed())window.webContents.send('forma:update-apply-error',{message:result.error});
  }finally{
    busy=false;
  }
}
license.on('change',()=>{applyRequestedUpdate().catch(()=>{});});
if (!single) {
  app.quit();
} else {
  app.on('second-instance', (_event,argv) => {
    if(argv.includes('--forma-apply-update')){applyUpdateRequested=true;applyRequestedUpdate().catch(()=>{});}
    if(argv.includes('--forma-check-update'))updater.check().catch(()=>{});
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

function settingsPath() {
  return settingsFile || (settingsFile = path.join(app.getPath('userData'), 'launcher-settings.json'));
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof raw[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = raw[key];
    }
  } catch { /* first start */ }
}

async function saveSettings() {
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function exists(target) {
  try { rawFs.accessSync(target); return true; } catch { return false; }
}

// Electron patches fs and routes paths through asar handling, which throws
// "ENOENT ... not found in <foreign>.asar" when reading other apps' archives.
// original-fs bypasses that layer so Qwen's app.asar is treated as a plain file.
const rawFs = require('original-fs');

async function installedAsarPackage(asarPath) {
  const file=await rawFs.promises.open(asarPath,'r');
  try{
    const prefix=Buffer.alloc(16);await file.read(prefix,0,16,0);
    const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
    if(jsonSize>16*1024*1024||headerSize<jsonSize||headerSize>jsonSize+16)throw new Error('Invalid ASAR header.');
    const header=Buffer.alloc(jsonSize);await file.read(header,0,jsonSize,16);
    const entry=JSON.parse(header.toString('utf8')).files['package.json'];
    const offset=Number(entry?.offset);if(!entry||entry.size>1024*1024||!Number.isSafeInteger(offset)||offset<0)throw new Error('Package metadata is missing.');
    const data=Buffer.alloc(entry.size);const result=await file.read(data,0,data.length,8+headerSize+offset);if(result.bytesRead!==data.length)throw new Error('The ASAR archive is incomplete.');
    return JSON.parse(data.toString('utf8'));
  }finally{await file.close()}
}

async function installedQwenPackage() {
  return installedAsarPackage(QWEN_ASAR);
}

async function hashFile(target) {
  let stat;
  try { stat = await rawFs.promises.stat(target); } catch { return null; }
  const key = target + '|' + stat.size + '|' + stat.mtimeMs;
  const cached = hashCache.get(target);
  if (cached && cached.key === key) return cached.hash;
  const hash = await new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = rawFs.createReadStream(target);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
  hashCache.set(target, { key, hash });
  return hash;
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: options.timeout || 20000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function qwenRunning() {
  if (IS_LINUX) {
    const result = await exec('pgrep', ['-f', '--forma-qwen']);
    return result.code === 0 && result.stdout.trim().length > 0;
  }
  const result = await exec('tasklist', ['/FI', 'IMAGENAME eq Qwen.exe', '/FO', 'CSV', '/NH']);
  return result.stdout.toLowerCase().includes('"qwen.exe"');
}

async function hashFileDirect(target) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const digest = crypto.createHash('sha256');
        const stream = rawFs.createReadStream(target);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(digest.digest('hex')));
      });
    } catch (e) {
      if (attempt < 4 && (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function stageAndVerifyFile(srcPath, destPath, expectedHash) {
  const stagePath = `${destPath}.forma-stage-${process.pid}`;
  const srcBytes = await rawFs.promises.readFile(srcPath);
  const actualSrcHash = crypto.createHash('sha256').update(srcBytes).digest('hex');
  if (expectedHash && actualSrcHash !== expectedHash) {
    throw new Error(`Bundled ${path.basename(srcPath)} checksum mismatch. Reinstall official Forma.`);
  }
  await rawFs.promises.unlink(stagePath).catch(() => {});
  await rawFs.promises.unlink(`${destPath}.forma-new`).catch(() => {});
  await rawFs.promises.writeFile(stagePath, srcBytes);
  const stagedHash = await hashFileDirect(stagePath);
  if (stagedHash !== actualSrcHash) {
    await rawFs.promises.unlink(stagePath).catch(() => {});
    throw new Error(`Staging ${path.basename(destPath)} failed verification (disk/antivirus lock). Temporarily allow Qwen folder or retry.`);
  }
  return { stagePath, expectedHash: actualSrcHash };
}

async function closeQwen(emit) {
  const stillUp = await qwenRunning();
  if (stillUp) {
    emit('Closing Qwen…');
    if (IS_LINUX) {
      await exec('pkill', ['-f', '--forma-qwen']);
    } else {
      await exec('taskkill', ['/IM', 'Qwen.exe']);
      for (let i = 0; i < 4; i += 1) {
        await new Promise((r) => setTimeout(r, 300));
        if (!(await qwenRunning())) break;
      }
      if (await qwenRunning()) {
        await exec('taskkill', ['/F', '/T', '/IM', 'Qwen.exe']);
      }
    }
  }
  if (!IS_LINUX) {
    await exec('taskkill', ['/F', '/IM', 'forma-core.exe']).catch(() => {});
  }
  for (let i = 0; i < 18; i += 1) {
    if (!(await qwenRunning())) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Qwen is still running. Close it and try again.');
}

let pythonCommand = null;
async function python() {
  if (pythonCommand) return pythonCommand;
  for (const candidate of (IS_LINUX ? ['python3', 'python'] : ['python', 'py'])) {
    const result = await exec(candidate, ['--version'], { timeout: 15000 });
    if (result.code === 0 && /Python\s+3/.test(result.stdout + result.stderr)) {
      pythonCommand = candidate;
      return candidate;
    }
  }
  throw new Error('Python 3 was not found. It is required for local source builds.');
}

function runStreaming(command, args, cwd, emit, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, FORMA_QA: '0', PYTHONUNBUFFERED: '1' } });
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The source build timed out.')); }, timeout);
    const push = (text) => {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) emit(line.trim());
    };
    child.stdout.on('data', (chunk) => push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); push(chunk.toString('utf8')); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) emit(buffer.trim());
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `Build beendet mit Code ${code}.`));
    });
  });
}

function sendProgress(payload) {
  if (window && !window.isDestroyed()) window.webContents.send('forma:progress', payload);
}

function createJob(kind, steps) {
  const state = steps.map((title, index) => ({ id: index, title, state: 'pending', detail: '' }));
  const emit = (patch) => sendProgress({ kind, ...patch, steps: state, at: Date.now() });
  emit({ phase: 'start', steps: state });
  return {
    steps: state,
    log: (line) => emit({ phase: 'log', line }),
    begin: (index, detail) => { state[index].state = 'active'; state[index].detail = detail || ''; emit({ phase: 'step', current: index }); },
    done: (index, detail) => { state[index].state = 'done'; state[index].detail = detail || ''; emit({ phase: 'step', current: index }); },
    fail: (index, message) => { state[index].state = 'error'; state[index].detail = message; emit({ phase: 'error', current: index, message }); },
    finish: (message) => emit({ phase: 'done', message })
  };
}

async function archiveInfo() {
  try {
    const stat = await fsp.stat(HISTORY_FILE);
    const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    const records = Array.isArray(data.records) ? data.records : [];
    let messages = 0;
    for (const record of records) {
      const history = record?.item?.chat?.history?.messages;
      messages += history && typeof history === 'object' ? Object.keys(history).length : 0;
    }
    return { available: true, chats: records.length, messages, bytes: stat.size, updated: stat.mtimeMs, accounts: new Set(records.flatMap((r) => Object.keys(r.replicas || {}))).size };
  } catch {
    return { available: false, chats: 0, messages: 0, bytes: 0, updated: 0, accounts: 0 };
  }
}

async function codeRunning() {
  if (IS_LINUX) return false;
  const result = await exec('tasklist', ['/FI', 'IMAGENAME eq Forma Code.exe', '/FO', 'CSV', '/NH']);
  return result.stdout.toLowerCase().includes('"forma code.exe"');
}

function resolveCodeDir() {
  if (IS_LINUX) return '';
  const candidates = [
    settings?.installPaths?.codeDir,
    CODE_DIR,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Forma Code'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Forma Code'),
    path.join(process.env.LOCALAPPDATA || '', 'Forma Code'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (exists(path.join(dir, 'Forma Code.exe'))) return dir;
  }
  return CODE_DIR;
}

async function detectFormaCode() {
  const dir = resolveCodeDir();
  const exe = dir ? path.join(dir, 'Forma Code.exe') : CODE_EXE;
  const asar = dir ? path.join(dir, 'resources', 'app.asar') : CODE_ASAR;
  const installed = !IS_LINUX && exists(exe);
  let version = null;
  if (installed && exists(asar)) {
    try { version = (await installedAsarPackage(asar))?.version || null; } catch {}
  }
  const running = installed ? await codeRunning() : false;
  return { installed, version, running, exePath: exe, dir };
}

/* ── Forma Claude ───────────────────────────────────────────────────────────
   Claude Desktop ships with embedded asar integrity. The first install clones
   the user's own Claude into %LOCALAPPDATA%\Programs\FormaClaude, disables the
   two fuses that reject a replaced bundle, then swaps resources/app.asar for
   the signed payload from the Forma Claude server. The original bundle is kept
   next to it as app.asar.forma-backup, so Restore is always one copy away. */

const CLAUDE_FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const CLAUDE_FUSE_DISABLE = 0x30;
let cachedClaudeDir = '';
let cachedClaudeAt = 0;

async function claudeRunning() {
  if (IS_LINUX) return false;
  const result = await exec('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH']);
  return result.stdout.toLowerCase().includes('"claude.exe"');
}

function isCompleteClaudeDir(dir) {
  return !!dir && exists(path.join(dir, CLAUDE_EXE_NAME)) && exists(path.join(dir, 'resources', 'app.asar'));
}

function normalizeCandidateClaudeDirs(rawPath) {
  const out = [];
  if (!rawPath) return out;
  const clean = String(rawPath).trim().replace(/^"+|"+$/g, '').split(',')[0].trim();
  if (!clean) return out;
  const dir = /\.exe$/i.test(clean) ? path.dirname(clean) : clean;
  out.push(dir, path.join(dir, 'app'));
  if (exists(dir)) {
    try {
      for (const entry of fs.readdirSync(dir).filter((n) => /^app-/i.test(n)).sort().reverse()) {
        out.push(path.join(dir, entry));
      }
    } catch {}
  }
  return out;
}

function claudeBaseDir() {
  if (IS_LINUX) return '';
  if (cachedClaudeDir && isCompleteClaudeDir(cachedClaudeDir)) return cachedClaudeDir;
  const saved = settings?.installPaths?.claudeDir;
  if (saved && isCompleteClaudeDir(saved)) {
    cachedClaudeDir = saved;
    return saved;
  }
  for (const dir of [CLAUDE_DIR, CLAUDE_DIR_LEGACY]) {
    if (isCompleteClaudeDir(dir)) {
      cachedClaudeDir = dir;
      return dir;
    }
  }
  const candidates = [];
  const anthropic = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude');
  if (exists(anthropic)) {
    try {
      for (const entry of fs.readdirSync(anthropic).filter((n) => /^app-/i.test(n)).sort().reverse()) {
        candidates.push(path.join(anthropic, entry));
      }
    } catch {}
    candidates.push(anthropic);
  }
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude'));
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Claude'));
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude'));
  candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude'));
  candidates.push(path.join(process.env.APPDATA || '', 'Claude'));
  const winApps = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  if (exists(winApps)) {
    try {
      for (const entry of fs.readdirSync(winApps).filter((n) => /^Claude_/i.test(n)).sort().reverse()) {
        candidates.push(path.join(winApps, entry, 'app'));
        candidates.push(path.join(winApps, entry));
      }
    } catch {}
  }
  for (const dir of candidates) {
    if (isCompleteClaudeDir(dir)) {
      cachedClaudeDir = dir;
      return dir;
    }
  }
  for (const dir of candidates) {
    if (exists(path.join(dir, CLAUDE_EXE_NAME))) return dir;
  }
  return '';
}

async function discoverClaudeDirAsync({ refresh = false } = {}) {
  if (IS_LINUX) return '';
  if (!refresh) {
    const syncHit = claudeBaseDir();
    if (syncHit && isCompleteClaudeDir(syncHit)) return syncHit;
    if (cachedClaudeAt && Date.now() - cachedClaudeAt < 20000 && cachedClaudeDir && isCompleteClaudeDir(cachedClaudeDir)) {
      return cachedClaudeDir;
    }
  } else {
    cachedClaudeDir = '';
    const syncHit = claudeBaseDir();
    if (syncHit && isCompleteClaudeDir(syncHit)) return syncHit;
  }

  cachedClaudeAt = Date.now();
  const discovered = [];
  // 1. MSIX / Store AppX package (works even when WindowsApps directory listing returns EACCES)
  try {
    const ps = [
      "$pkgs = @(Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)",
      'foreach ($p in $pkgs) { if ($p.InstallLocation) { Write-Output $p.InstallLocation } }',
      "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
      "Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Claude' } | ForEach-Object { if ($_.InstallLocation) { Write-Output $_.InstallLocation }; if ($_.DisplayIcon) { Write-Output $_.DisplayIcon } }",
      "$sh = New-Object -ComObject WScript.Shell",
      "$roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ -and (Test-Path $_) }",
      "foreach ($r in $roots) { Get-ChildItem -Path $r -Filter '*Claude*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t) { Write-Output $t } } catch {} } }",
    ].join('; ');
    const res = await exec('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      for (const cand of normalizeCandidateClaudeDirs(line)) discovered.push(cand);
    }
  } catch {}

  for (const dir of discovered) {
    if (isCompleteClaudeDir(dir)) {
      cachedClaudeDir = dir;
      settings.installPaths = { ...(settings.installPaths || {}), claudeDir: dir };
      try { if (settingsFile) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch {}
      return dir;
    }
  }
  return claudeBaseDir();
}

async function autoInstallClaudeDesktop(job) {
  if (IS_LINUX) return '';
  job.begin(1, 'Claude Desktop not found — installing automatically via winget…');
  const hasWinget = await exec('where', ['winget'], { timeout: 6000 });
  if (hasWinget.code !== 0) return '';
  const res = await exec(
    'winget',
    ['install', '--id', 'Anthropic.Claude', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent'],
    { timeout: 240000 },
  );
  if (res.code !== 0) {
    job.log(`winget install exited with code ${res.code}; checking if Claude Desktop appeared anyway.`);
  }
  for (let i = 0; i < 6; i += 1) {
    const found = await discoverClaudeDirAsync({ refresh: true });
    if (found && isCompleteClaudeDir(found)) return found;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

/* Key handoff. The app owns activation; the launcher only needs to deliver a
   key the user pasted here. The handoff is a one-shot file the app deletes
   after storing the key with DPAPI, so no key ever stays in plain text. */

function claudeKeyInfo() {
  const keyFile = path.join(CLAUDE_SYS, '.fc_k.dat');
  const deviceFile = path.join(CLAUDE_SYS, '.fc_d.dat');
  const stateFile = path.join(CLAUDE_SYS, '.fc_state.json');
  let status = 'none';
  let licenseId = null;
  let expiresAt = 0;
  let updatedAt = 0;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (data && typeof data.status === 'string') status = data.status;
    licenseId = data?.licenseId || null;
    expiresAt = Number(data?.expiresAt) || 0;
    updatedAt = Number(data?.updatedAt) || 0;
  } catch { /* the app has not published a status yet */ }
  const hasKey = exists(keyFile);
  if (status === 'none' && hasKey) status = 'stored';
  let device = '';
  try { device = fs.readFileSync(deviceFile, 'utf8').trim(); } catch { /* first run */ }
  return { status, hasKey, licenseId, expiresAt, updatedAt, device };
}

function writeClaudeHandoff(key) {
  const clean = String(key || '').trim();
  if (!/^FORMA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error('That is not a valid Forma key. Copy the whole key from the key page.');
  }
  fs.mkdirSync(CLAUDE_SYS, { recursive: true, mode: 0o700 });
  const file = path.join(CLAUDE_SYS, '.fc_handoff');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, key: clean, at: Date.now(), source: 'launcher' }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || '';
    if (user) exec('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`]).catch(() => {});
  }
  return { ok: true };
}

async function claudeArchiveInfo() {
  try {
    const entries = await fsp.readdir(CLAUDE_ARCHIVE);
    const files = entries.filter((n) => n.endsWith('.json') && !['index.json', 'orgs.json', '_failures.json'].includes(n));
    let chats = 0;
    let messages = 0;
    let updated = 0;
    let bytes = 0;
    const accounts = new Set();
    for (const name of files) {
      const full = path.join(CLAUDE_ARCHIVE, name);
      try {
        const st = await fsp.stat(full);
        bytes += st.size;
        updated = Math.max(updated, st.mtimeMs);
        const data = JSON.parse(await fsp.readFile(full, 'utf8'));
        chats += Number(data.count) || (Array.isArray(data.conversations) ? data.conversations.length : 0);
        for (const conv of data.conversations || []) messages += (conv.messages || []).length;
        if (data.email) accounts.add(String(data.email));
      } catch {}
    }
    return { available: files.length > 0, chats, messages, accounts: accounts.size, bytes, updated, path: CLAUDE_ARCHIVE };
  } catch {
    return { available: false, chats: 0, messages: 0, accounts: 0, bytes: 0, updated: 0, path: CLAUDE_ARCHIVE };
  }
}

async function detectClaude() {
  if (IS_LINUX) return { installed: false, key: claudeKeyInfo(), archive: await claudeArchiveInfo() };
  const dir = await discoverClaudeDirAsync();
  const installed = !!dir;
  const asar = installed ? path.join(dir, 'resources', 'app.asar') : '';
  let version = null;
  if (installed && exists(asar)) {
    try { version = (await installedAsarPackage(asar))?.version || null; } catch {}
  }
  let manifest = null;
  if (installed) {
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, 'resources', '.forma-install.json'), 'utf8'));
    } catch { /* not installed by Forma yet */ }
  }
  return {
    installed,
    dir,
    exe: installed ? path.join(dir, CLAUDE_EXE_NAME) : '',
    asar,
    backup: asar ? asar + '.forma-backup' : '',
    version,
    managedVersion: manifest?.version || null,
    managedHash: manifest?.asarSha256 || null,
    running: installed ? await claudeRunning() : false,
    hash: asar ? await hashFile(asar) : null,
    patched: !!asar && exists(asar + '.forma-backup'),
    key: claudeKeyInfo(),
    archive: await claudeArchiveInfo(),
  };
}

function claudeFuseMarker(exePath) {
  return path.join(path.dirname(exePath), 'resources', '.forma-fuses.json');
}

function patchClaudeFuses(exePath) {
  if (!exists(exePath)) return false;
  const buf = fs.readFileSync(exePath);
  const at = buf.indexOf(Buffer.from(CLAUDE_FUSE_SENTINEL, 'latin1'));
  if (at < 0) return false;
  const count = buf[at + CLAUDE_FUSE_SENTINEL.length + 1];
  const base = at + CLAUDE_FUSE_SENTINEL.length + 2;
  if (count < 6) return false;
  const marker = claudeFuseMarker(exePath);
  if (!exists(marker)) {
    try {
      fs.writeFileSync(marker, JSON.stringify({ base, count, bytes: [buf[base + 4], buf[base + 5]] }));
    } catch { /* the marker is a convenience for Restore only */ }
  }
  let changed = false;
  for (const idx of [4, 5]) {
    if (buf[base + idx] !== CLAUDE_FUSE_DISABLE) {
      buf[base + idx] = CLAUDE_FUSE_DISABLE;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(exePath, buf);
  return true;
}

function restoreClaudeFuses(exePath) {
  if (!exists(exePath)) return false;
  const marker = claudeFuseMarker(exePath);
  try {
    const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (!Number.isInteger(data.base) || !Array.isArray(data.bytes) || data.bytes.length !== 2) return false;
    const buf = fs.readFileSync(exePath);
    buf[data.base + 4] = data.bytes[0];
    buf[data.base + 5] = data.bytes[1];
    fs.writeFileSync(exePath, buf);
    fs.rmSync(marker, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function closeClaude(emit) {
  if (!(await claudeRunning())) return;
  if (emit) emit('Closing Claude…');
  await exec('taskkill', ['/F', '/T', '/IM', 'claude.exe']);
  for (let i = 0; i < 24; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await claudeRunning())) return;
  }
  throw new Error('Claude is still running. Close it and try again.');
}

async function copyDirWithProgress(src, dst, onProgress) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(from);
      else if (entry.isFile()) files.push(from);
    }
  }
  await walk(src);
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  let done = 0;
  let last = 0;
  await fsp.mkdir(dst, { recursive: true });
  for (const from of files) {
    const to = path.join(dst, path.relative(src, from));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    done += fs.statSync(from).size;
    const now = Date.now();
    if (now - last > 300) {
      last = now;
      onProgress(done, total || 1);
    }
  }
  onProgress(done, total || 1);
}

async function resolveClaudeRelease() {
  const res = await fetch(`${CLAUDE_API}/v1/releases/latest`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': `Forma-Launcher/${app.getVersion()}` },
  });
  if (!res.ok) throw new Error(`Forma Claude release catalog unavailable (HTTP ${res.status}).`);
  const body = await res.json();
  const envelope = body?.envelope;
  if (!envelope?.payload || !envelope?.signature) throw new Error('The Forma Claude release envelope is missing.');
  const ok = crypto.verify(
    null,
    Buffer.from(`FORMA-CLAUDE-RELEASE-v1\n${envelope.payload}`, 'utf8'),
    crypto.createPublicKey(CLAUDE_PUBLIC_KEY),
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!ok) throw new Error('Signed Forma Claude release verification failed.');
  const p = JSON.parse(envelope.payload);
  const asset = (p.assets || []).find((a) => /\.zip$/i.test(String(a.url || '')));
  if (!asset) throw new Error('The Forma Claude release has no Windows payload.');
  return {
    version: String(p.version || '0.0.0'),
    notes: String(p.notes || ''),
    url: String(asset.url),
    sha256: String(asset.sha256 || '').toLowerCase(),
    size: Number(asset.size) || 0,
    asarSha256: String(p.asarSha256 || '').toLowerCase(),
    mandatory: !!p.mandatory,
  };
}

async function extractClaudePayload(zip, stage) {
  await fsp.mkdir(stage, { recursive: true });
  let result = await exec('tar', ['-xf', zip, '-C', stage], { timeout: 180000 });
  if (result.code !== 0) {
    const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`;
    result = await exec('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 240000 });
  }
  if (result.code !== 0) throw new Error('The payload archive could not be extracted.');
  const found = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'app.asar') found.push(full);
    }
  }
  await walk(stage);
  if (!found.length) throw new Error('The payload does not contain app.asar.');
  return found[0];
}

async function installClaudePipeline(options = {}) {
  if (IS_LINUX) return { ok: false, error: 'Forma Claude is currently packaged for Windows.' };
  const installed = await detectClaude();
  if (!installed.installed && !options.force) {
    return { ok: true, skipped: true, reason: 'Claude Desktop is not installed yet.' };
  }
  const job = createJob('claude-install', [
    'Check latest release',
    'Prepare Claude Desktop',
    'Download payload',
    'Verify SHA-256',
    'Close Claude',
    'Install app.asar',
    'Verify installation',
    'Launch Claude',
  ]);
  let tmp = '';
  let stage = '';
  try {
    job.begin(0);
    const rel = await resolveClaudeRelease();
    const current = await detectClaude();
    const upToDate = current.installed && !!current.managedVersion
      && current.managedVersion === rel.version
      && current.hash === current.managedHash;
    if (!options.force && upToDate) {
      job.done(0, `v${rel.version} up to date`);
      job.done(1, 'Skipped');
      job.done(2, 'Skipped');
      job.done(3, 'Verified');
      job.done(4, 'Skipped');
      job.done(5, 'Skipped');
      job.done(6, current.hash.slice(0, 12) + ' …');
      if (options.launch) await launchClaude();
      job.done(7, options.launch ? 'Launched' : 'Ready');
      job.finish(`Forma Claude v${rel.version} is already up to date.`);
      return { ok: true, version: rel.version, upToDate: true };
    }
    job.done(0, `v${rel.version}`);

    job.begin(1);
    let base = await discoverClaudeDirAsync({ refresh: true });
    if (!base || !isCompleteClaudeDir(base)) {
      base = await autoInstallClaudeDesktop(job);
    }
    if (!base || !isCompleteClaudeDir(base)) {
      throw new Error('Claude Desktop could not be located or installed automatically. Install it from https://claude.ai/download, then press Install again.');
    }
    const normal = (p) => path.resolve(p).toLowerCase();
    if (normal(base) !== normal(CLAUDE_DIR) && normal(base) !== normal(CLAUDE_DIR_LEGACY)) {
      job.begin(1, 'Copying Claude Desktop into FormaClaude');
      await closeClaude(job.log);
      if (exists(CLAUDE_DIR)) await fsp.rm(CLAUDE_DIR, { recursive: true, force: true });
      await copyDirWithProgress(base, CLAUDE_DIR, (done, total) => {
        job.begin(1, `Copying Claude Desktop · ${Math.floor((done / total) * 100)}%`);
      });
      base = CLAUDE_DIR;
    }
    const target = base;
    const exe = path.join(target, CLAUDE_EXE_NAME);
    const asar = path.join(target, 'resources', 'app.asar');
    if (!exists(exe) || !exists(asar)) throw new Error('The Claude Desktop installation is incomplete.');
    if (!patchClaudeFuses(exe)) job.log('Fuse wire not found; continuing with the existing runtime.');
    job.done(1, target);

    job.begin(2, rel.url.split('/').pop());
    tmp = path.join(app.getPath('temp'), `forma-claude-${rel.version}-${Date.now()}.zip`);
    const dl = await fetch(rel.url, { signal: AbortSignal.timeout(300000) });
    if (!dl.ok) throw new Error(`Payload download failed (HTTP ${dl.status}).`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    await rawFs.promises.writeFile(tmp, bytes);
    job.done(2, `${(bytes.length / 1048576).toFixed(1)} MB`);

    job.begin(3);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== rel.sha256) throw new Error('Payload SHA-256 verification failed.');
    job.done(3, digest.slice(0, 12) + ' …');

    job.begin(4);
    await closeClaude(job.log);
    job.done(4, 'Claude closed');

    job.begin(5);
    stage = path.join(app.getPath('temp'), `forma-claude-stage-${Date.now()}`);
    const newAsar = await extractClaudePayload(tmp, stage);
    const newHash = await hashFileDirect(newAsar);
    if (rel.asarSha256 && newHash !== rel.asarSha256) throw new Error('The payload app.asar does not match the signed release.');
    const backup = asar + '.forma-backup';
    if (!exists(backup)) {
      await rawFs.promises.copyFile(asar, backup);
      job.log('Original Claude bundle backed up.');
    }
    const staged = asar + '.forma-new';
    const rollback = asar + '.forma-previous';
    await rawFs.promises.copyFile(newAsar, staged);
    if (await hashFileDirect(staged) !== newHash) throw new Error('The staged bundle was modified.');
    await rawFs.promises.copyFile(asar, rollback);
    try {
      await rawFs.promises.copyFile(staged, asar);
    } catch (error) {
      await rawFs.promises.copyFile(rollback, asar).catch(() => {});
      throw error;
    }
    for (const file of [staged, rollback]) await rawFs.promises.unlink(file).catch(() => {});
    job.done(5, 'app.asar installed');

    job.begin(6);
    hashCache.delete(asar);
    const installedHash = await hashFile(asar);
    if (installedHash !== newHash) throw new Error('Installation checksum verification failed.');
    try {
      await rawFs.promises.writeFile(
        path.join(target, 'resources', '.forma-install.json'),
        JSON.stringify({ version: rel.version, asarSha256: installedHash, installedAt: Date.now() }, null, 2),
      );
    } catch (error) {
      job.log(`Install marker could not be written: ${error.message}`);
    }
    job.done(6, installedHash.slice(0, 12) + ' …');

    job.begin(7);
    if (options.launch) {
      await launchClaude();
      job.done(7, 'Claude launched');
    } else {
      job.done(7, 'Skipped');
    }
    job.finish(`Forma Claude v${rel.version} installed & verified.`);
    setTimeout(() => collectLauncherTelemetry({ fast: false }).catch(() => {}), 500);
    return { ok: true, version: rel.version };
  } catch (error) {
    const index = job.steps.findIndex((s) => s.state === 'active');
    job.fail(index < 0 ? 0 : index, error.message);
    return { ok: false, error: error.message };
  } finally {
    if (tmp) await rawFs.promises.unlink(tmp).catch(() => {});
    if (stage) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

async function launchClaude() {
  license.requireActive();
  if (IS_LINUX) throw new Error('Forma Claude is currently packaged for Windows.');
  const current = await detectClaude();
  if (!current.installed) throw new Error('Claude Desktop is not installed. Install it, then press Install in the launcher.');
  const rel = await resolveClaudeRelease().catch(() => null);
  if (rel && current.managedVersion !== rel.version) {
    const result = await installClaudePipeline({ launch: false });
    if (!result.ok) throw new Error(result.error);
  }
  const child = spawn(current.exe, [], { cwd: current.dir, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (settings.hideOnLaunch && window) window.hide();
  return { launched: true };
}

async function restoreClaude() {
  const current = await detectClaude();
  if (!current.installed) throw new Error('Claude Desktop is not installed.');
  const backup = current.asar + '.forma-backup';
  if (!exists(backup)) throw new Error('No original Claude bundle backup was found.');
  await closeClaude(() => {});
  await rawFs.promises.copyFile(backup, current.asar);
  restoreClaudeFuses(current.exe);
  await fsp.rm(path.join(current.dir, 'resources', '.forma-install.json'), { force: true }).catch(() => {});
  hashCache.delete(current.asar);
  return { ok: true, restored: true };
}

async function collectState() {
  const [installedHash, buildHash, originalHash, formaCode, claude] = await Promise.all([
    hashFile(QWEN_ASAR), hashFile(path.join(PROJECT_DIR, 'Forma.asar')), hashFile(path.join(PROJECT_DIR, 'Original-Qwen.asar')), detectFormaCode(), detectClaude()
  ]);
  const running = await qwenRunning();
  let qwenVersion = null;
  try {
    const pkg = await installedQwenPackage();
    qwenVersion = pkg.version || null;
  } catch { /* optional */ }
  return {
    platform: process.platform,
    license: license.snapshot(),
    update: updater.state(),
    launcher: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
    settings,
    busy,
    formaCode,
    claude,
    paths: {
      project: PROJECT_DIR,
      runtime: RUNTIME_DIR,
      qwen: QWEN_DIR,
      qwenExe: QWEN_EXE,
      installedAsar: QWEN_ASAR,
      buildAsar: path.join(PROJECT_DIR, 'Forma.asar'),
      originalAsar: path.join(PROJECT_DIR, 'Original-Qwen.asar'),
      source: path.join(PROJECT_DIR, 'source'),
      archive: HISTORY_FILE,
      workspace: path.join(QWEN_DATA, 'forma', 'workspace'),
      claude: CLAUDE_DIR,
      claudeExe: claude.exe || path.join(CLAUDE_DIR, CLAUDE_EXE_NAME),
      claudeAsar: claude.asar || path.join(CLAUDE_DIR, 'resources', 'app.asar'),
      claudeArchive: CLAUDE_ARCHIVE,
      claudeKeyUrl: CLAUDE_KEY_URL
    },
    qwen: {
      installed: IS_LINUX ? !!buildHash : exists(QWEN_EXE)&&exists(QWEN_ASAR),
      version: qwenVersion || (IS_LINUX ? '1.0.3' : null),
      running,
      modded: IS_LINUX ? (!!installedHash && !!buildHash && installedHash === buildHash) : (!!installedHash && !!buildHash && installedHash === buildHash),
      stock: IS_LINUX ? false : installedHash === ORIGINAL_SHA,
      installedHash,
      buildHash,
      originalHash,
      buildPresent: !!buildHash,
      backupPresent: IS_LINUX ? true : !!originalHash,
      sourcePresent: exists(path.join(PROJECT_DIR, 'source', 'forma-main.cjs')),
      extractPresent: exists(path.join(PROJECT_DIR, '..', '..', 'work', 'qwen-original', 'out', 'main', 'index.js'))
    }
  };
}

async function launchQwen(extraArgs=[]) {
  license.requireActive();
  if (IS_LINUX) {
    const manifest = require('./payload-manifest.json');
    if (manifest['Forma.asar'] && (await hashFile(QWEN_ASAR)) !== manifest['Forma.asar']) {
      throw new Error('The Forma payload was modified. Reinstall or re-download Forma.');
    }
    await fsp.mkdir(path.join(QWEN_DATA, 'forma', 'workspace'), { recursive: true });
    const spawnBin = process.env.APPIMAGE || process.execPath;
    const args = [];
    if (!app.isPackaged) args.push(path.join(__dirname, 'main.cjs'));
    if (process.argv.includes('--no-sandbox') || process.env.APPIMAGE) args.push('--no-sandbox');
    args.push('--forma-qwen', '--user-data-dir=' + QWEN_DATA,...extraArgs);
    const child = spawn(spawnBin, args, { cwd: app.getPath('home'), detached: true, stdio: 'ignore' });
    child.unref();
    if (settings.hideOnLaunch && window) window.hide();
    return { launched: true };
  }
  if (!exists(QWEN_EXE)) throw new Error('Qwen is not installed: ' + QWEN_EXE);
  if(await hashFile(QWEN_ASAR)!==require('./payload-manifest.json')['Forma.asar']){const result=await installPipeline({rebuild:false,launch:true});if(!result.ok)throw new Error(result.error);return {launched:true,updated:true};}
  if(await hashFile(QWEN_EXE)!==require('./payload-manifest.json')['Qwen.exe'])throw new Error('The Qwen runtime was modified. Reinstall the verified integration.');
  if (shield) {
    const preLaunch = await shield.runAudit({ forceRescan: true });
    if (preLaunch.blocked) {
      throw new Error('Security verification failed. Reinstall official Forma and close debugging or proxy tools.');
    }
  }
  license.requireActive();
  const launcherBaseDir = app.isPackaged ? path.dirname(process.execPath) : LAUNCHER_DIR;
  await writeLauncherAnchor({
    vault: launcherVault,
    rootDir: path.join(app.getPath('appData'), 'FormaAccess'),
    launcherDir: launcherBaseDir,
    payloadManifest: (() => { try { return require('./payload-manifest.json'); } catch { return null; } })(),
    appVersion: app.getVersion(),
  }).catch(() => {});
  const launchArgs = app.isPackaged ? ['--forma-launcher-dir=' + launcherBaseDir, ...extraArgs] : extraArgs;
  const child = spawn(QWEN_EXE, launchArgs, { cwd: QWEN_DIR, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (settings.hideOnLaunch && window) window.hide();
  return { launched: true };
}

/**
 * Compare the bundled payload with its manifest. Returns a report instead of
 * throwing: a hash mismatch must never dead-end the installer or feed the
 * server a failing command that it retries forever.
 */
async function payloadReport() {
  let expected = {};
  try { expected = require('./payload-manifest.json') || {}; } catch {}
  const problems = [];
  for (const name of ['Forma.asar', 'Qwen.exe', 'Original-Qwen.asar']) {
    const want = expected[name];
    if (!want) continue;
    const actual = await hashFile(path.join(PROJECT_DIR, name));
    if (!actual || String(actual).toLowerCase() !== String(want).toLowerCase()) {
      problems.push({ name, actual: actual || 'missing', expected: want });
    }
  }
  return problems;
}

/** True when the installed Qwen runtime already matches the bundled payload. */
async function qwenAlreadyCurrent() {
  try {
    const expected = require('./payload-manifest.json') || {};
    if (!exists(QWEN_ASAR) || !exists(QWEN_EXE)) return false;
    if (expected['Forma.asar'] && (await hashFile(QWEN_ASAR)) !== expected['Forma.asar']) return false;
    if (expected['Qwen.exe'] && (await hashFile(QWEN_EXE)) !== expected['Qwen.exe']) return false;
    return true;
  } catch {
    return false;
  }
}

async function installPipeline(options = {}) {
  license.requireActive();
  const expectedPayload = require('./payload-manifest.json');
  if (!options.force && !options.rebuild && await qwenAlreadyCurrent()) {
    return { ok: true, skipped: true, current: true };
  }
  if (IS_LINUX) {
    const job = createJob('install', ['Verify bundle', 'Prepare workspace', 'Close Qwen', 'Verify integration', 'Launch Qwen']);
    try {
      job.begin(0);
      const asarPath = path.join(PROJECT_DIR, 'Forma.asar');
      const buildHash = await hashFile(asarPath);
      if (!buildHash || (expectedPayload['Forma.asar'] && buildHash !== expectedPayload['Forma.asar'])) {
        throw new Error('Forma.asar integrity check failed.');
      }
      job.done(0, buildHash.slice(0, 12) + ' …');

      job.begin(1);
      await fsp.mkdir(path.join(QWEN_DATA, 'forma', 'workspace'), { recursive: true });
      const archive = await archiveInfo();
      job.done(1, archive.available ? `${archive.chats} chats · ${archive.messages} messages` : 'Workspace initialized');

      job.begin(2);
      await closeQwen(job.log);
      job.done(2, 'Ready');

      job.begin(3);
      job.done(3, 'Native Linux bundle verified');

      job.begin(4);
      const shouldLaunch = options.launch !== undefined ? options.launch : settings.launchAfterInstall;
      if (shouldLaunch) { await launchQwen(); job.done(4, 'Qwen launched'); }
      else job.done(4, 'Skipped');

      job.finish('Forma for Linux is ready. Launch Qwen anytime.');
      return { ok: true };
    } catch (error) {
      const index = job.steps.findIndex((step) => step.state === 'active');
      job.fail(index < 0 ? 0 : index, error.message);
      return { ok: false, error: error.message };
    }
  }
  const job = createJob('install', ['Prerequisites', 'Prepare integration', 'Verify archive', 'Close Qwen', 'Install', 'Verify', 'Launch Qwen']);
  try {
    job.begin(0);
    const problems = await payloadReport();
    if (problems.length) {
      const detail = problems.map((p) => `${p.name} (${String(p.actual).slice(0, 12)} != ${String(p.expected).slice(0, 12)})`).join(', ');
      job.log('Payload notice: ' + detail);
      console.warn('[forma] payload hash notice', problems);
    } else {
      job.log('Payload verified');
    }
    if (!exists(QWEN_EXE)||!exists(QWEN_ASAR)) {
      job.log('Downloading the official Qwen 1.0.3 installer.');
      await installQwen({folder:path.join(app.getPath('userData'),'downloads'),requireActive:()=>license.requireActive(),
        onProgress:(size,total)=>job.begin(0, total ? `Downloading Qwen · ${Math.floor(size*100/total)}%` : `Downloading Qwen · ${Math.floor(size/1048576)} MB`),
        verify:async()=>exists(QWEN_EXE)&&exists(QWEN_ASAR)});
      job.log('Official Qwen setup completed.');
    }
    const installedPackage=await installedQwenPackage();
    if(installedPackage.version!=='1.0.3')throw new Error('Forma supports Qwen Desktop 1.0.3. Installed version: '+installedPackage.version+'. Your installation was not changed.');
    const needsBuild = options.rebuild === true && settings.rebuild;
    const py = needsBuild ? await python() : null;
    job.done(0, 'Qwen found');

    const rebuild = options.rebuild === true && settings.rebuild;
    job.begin(1, rebuild ? 'Running build.py' : 'Using the bundled archive');
    if (rebuild) {
      if (!exists(path.join(PROJECT_DIR, '..', '..', 'work', 'qwen-original'))) throw new Error('The original source extraction is missing.');
      await runStreaming(py, ['build.py'], PROJECT_DIR, job.log);
      job.done(1, 'Forma.asar rebuilt');
    } else {
      if (!exists(path.join(PROJECT_DIR, 'Forma.asar'))) throw new Error('Forma.asar is missing. Rebuild the integration first.');
      job.done(1, 'Skipped; using the bundled archive');
    }

    job.begin(2);
    const buildHash = await hashFile(path.join(PROJECT_DIR, 'Forma.asar'));
    if (!buildHash) throw new Error('Forma.asar was not generated.');
    const archive = await archiveInfo();
    job.done(2, archive.available ? `${archive.chats} chats · ${archive.messages} messages backed up` : 'No chat archive found');

    job.begin(3);
    if (!exists(path.join(PROJECT_DIR, 'Original-Qwen.asar'))) {
      const currentHash = await hashFile(QWEN_ASAR);
      if (currentHash !== ORIGINAL_SHA) throw new Error('The installed Qwen build differs from the verified original. The original backup was preserved.');
      await rawFs.promises.copyFile(QWEN_ASAR, path.join(PROJECT_DIR, 'Original-Qwen.asar'));
      job.log('Original backup created.');
    }
    license.requireActive();
    await closeQwen(job.log);
    job.done(3, 'Qwen closed');

    job.begin(4);
    const hardenedExe=path.join(PROJECT_DIR,'Qwen.exe');
    if(!exists(hardenedExe))throw new Error('The verified Qwen runtime is missing from the package.');
    await fsp.mkdir(path.dirname(ORIGINAL_EXE_BACKUP),{recursive:true});
    if(!exists(ORIGINAL_EXE_BACKUP))await rawFs.promises.copyFile(QWEN_EXE,ORIGINAL_EXE_BACKUP);
    const stagedAsarInfo=await stageAndVerifyFile(path.join(PROJECT_DIR,'Forma.asar'),QWEN_ASAR,buildHash);
    const expectedExe=await hashFileDirect(hardenedExe);
    const stagedExeInfo=await stageAndVerifyFile(hardenedExe,QWEN_EXE,expectedExe);
    const rollbackAsar=QWEN_ASAR+'.forma-previous',rollbackExe=QWEN_EXE+'.forma-previous';
    await rawFs.promises.unlink(rollbackAsar).catch(()=>{});
    await rawFs.promises.unlink(rollbackExe).catch(()=>{});
    await rawFs.promises.copyFile(QWEN_ASAR,rollbackAsar);await rawFs.promises.copyFile(QWEN_EXE,rollbackExe);
    license.requireActive();
    try{
      await rawFs.promises.chmod(QWEN_ASAR,0o666).catch(()=>{});
      await rawFs.promises.copyFile(stagedAsarInfo.stagePath,QWEN_ASAR);
      await rawFs.promises.chmod(QWEN_EXE,0o666).catch(()=>{});
      await rawFs.promises.copyFile(stagedExeInfo.stagePath,QWEN_EXE);
      if(!IS_LINUX)await rawFs.promises.chmod(QWEN_ASAR,0o444).catch(()=>{});
    }catch(error){
      await rawFs.promises.chmod(QWEN_ASAR,0o666).catch(()=>{});
      await rawFs.promises.copyFile(rollbackAsar,QWEN_ASAR).catch(()=>{});
      await rawFs.promises.copyFile(rollbackExe,QWEN_EXE).catch(()=>{});
      throw error;
    }finally{
      await rawFs.promises.unlink(stagedAsarInfo.stagePath).catch(()=>{});
      await rawFs.promises.unlink(stagedExeInfo.stagePath).catch(()=>{});
    }
    for(const temporary of [rollbackAsar,rollbackExe])await rawFs.promises.unlink(temporary).catch(()=>{});
    job.done(4, 'app.asar installed');

    job.begin(5);
    hashCache.delete(QWEN_ASAR);
    hashCache.delete(QWEN_EXE);
    const installedHash = await hashFileDirect(QWEN_ASAR);
    if (installedHash !== buildHash) throw new Error('Installation checksum verification failed.');
    job.done(5, installedHash.slice(0, 12) + ' …');

    job.begin(6);
    const shouldLaunch = options.launch !== undefined ? options.launch : settings.launchAfterInstall;
    if (shouldLaunch) { await launchQwen(); job.done(6, 'Qwen launched'); }
    else job.done(6, 'Skipped');

    job.finish('Forma integration installed. Your chats and sign-in are preserved.');
    return { ok: true };
  } catch (error) {
    const index = job.steps.findIndex((step) => step.state === 'active');
    job.fail(index < 0 ? 0 : index, error.message);
    return { ok: false, error: error.message };
  }
}

async function restorePipeline() {
  if (IS_LINUX) {
    return { ok: false, error: 'On Linux, Qwen is bundled directly inside Forma.' };
  }
  const job = createJob('restore', ['Verify backup', 'Close Qwen', 'Install original', 'Verify']);
  try {
    job.begin(0);
    const backup = path.join(PROJECT_DIR, 'Original-Qwen.asar');
    const backupHash = await hashFile(backup);
    if (!backupHash) throw new Error('Original-Qwen.asar is missing.');
    if (backupHash !== ORIGINAL_SHA) throw new Error('The backup does not match the verified original.');
    job.done(0, backupHash.slice(0, 12) + ' …');

    job.begin(1);
    await closeQwen(job.log);
    job.done(1, 'Qwen closed');

    job.begin(2);
    if(!exists(ORIGINAL_EXE_BACKUP))throw new Error('The original Qwen runtime backup is missing.');
    if(await hashFile(ORIGINAL_EXE_BACKUP)!==require('./payload-manifest.json')._originalExe)throw new Error('The original runtime backup was modified.');
    await rawFs.promises.chmod(QWEN_EXE, 0o666).catch(() => {});
    await rawFs.promises.chmod(QWEN_ASAR, 0o666).catch(() => {});
    await rawFs.promises.copyFile(ORIGINAL_EXE_BACKUP,QWEN_EXE);
    await rawFs.promises.copyFile(backup, QWEN_ASAR);
    job.done(2, 'Original restored');

    job.begin(3);
    hashCache.delete(QWEN_ASAR);
    const installedHash = await hashFile(QWEN_ASAR);
    if (installedHash !== ORIGINAL_SHA) throw new Error('Restore checksum verification failed.');
    job.done(3, 'Verified original active');

    job.finish('Original Qwen restored. Your chats and sign-in are preserved.');
    return { ok: true };
  } catch (error) {
    const index = job.steps.findIndex((step) => step.state === 'active');
    job.fail(index < 0 ? 0 : index, error.message);
    return { ok: false, error: error.message };
  }
}

function applyMaterial() {
  if (IS_LINUX || !window || window.isDestroyed()) return;
  try { window.setBackgroundMaterial(settings.acrylic ? 'acrylic' : 'none'); } catch { /* older Windows */ }
}

function createWindow() {
  const winOpts = {
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0A0B0D',
    title: 'Forma',
    icon: path.join(__dirname, 'assets', IS_LINUX ? 'forma-256.png' : 'forma.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  };
  if (!IS_LINUX) winOpts.backgroundMaterial = settings.acrylic ? 'acrylic' : 'none';
  window = new BrowserWindow(winOpts);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => { window.show(); window.focus(); applyRequestedUpdate().catch(()=>{}); });
  window.on('maximize', () => window.webContents.send('forma:progress', { kind: 'window', maximized: true }));
  window.on('unmaximize', () => window.webContents.send('forma:progress', { kind: 'window', maximized: false }));
  window.on('closed', () => { window = null; });
}

app.whenReady().then(async () => {
  loadSettings();
  if (app.isPackaged) {
    await writeLauncherAnchor({
      vault: launcherVault,
      rootDir: path.join(app.getPath('appData'), 'FormaAccess'),
      launcherDir: path.dirname(process.execPath),
      payloadManifest: (() => { try { return require('./payload-manifest.json'); } catch { return null; } })(),
      appVersion: app.getVersion(),
    }).catch(() => {});
  }
  createWindow();
  setTimeout(()=>{collectLauncherTelemetry().catch(()=>{});},350).unref();
  setTimeout(()=>{updater.check({autoDownload:true}).catch(()=>{});applyRequestedUpdate().catch(()=>{});},3000).unref();
  const updateTimer=setInterval(()=>updater.check({autoDownload:true}).catch(()=>{}),10*60*1000);updateTimer.unref();
  app.on('before-quit',()=>{clearTimeout(autoInstallTimer);clearInterval(updateTimer);shield?.stopWatchdog();});
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const registerHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>registerHandle(channel,async(event,...args)=>{
  if(event.sender!==window?.webContents||event.senderFrame!==window?.webContents.mainFrame)throw Error('Unauthorized launcher request.');
  return handler(event,...args);
});

function guarded(handler) {
  return async (_event, payload) => {
    if (busy) return { ok: false, error: 'An operation is already running.' };
    busy = true;
    try { license.requireActive(); return await handler(payload); }
    catch (error) { return { ok: false, error: error.message }; }
    finally { busy = false; }
  };
}

function localUpdate(event){if(event.sender!==window?.webContents||event.senderFrame!==window?.webContents.mainFrame)throw Error('Unauthorized update request.');}
ipcMain.handle('forma:update-state',async(event)=>{localUpdate(event);return updater.state()});
ipcMain.handle('forma:update-check',async(event,options)=>{localUpdate(event);return updater.check(options||{autoDownload:false})});
ipcMain.handle('forma:update-download',async(event)=>{localUpdate(event);return updater.download()});
ipcMain.handle('forma:update-install',async(event)=>{localUpdate(event);if(busy)throw Error('An installation is already running.');return updater.install()});
ipcMain.handle('forma:state', async () => collectState());
ipcMain.handle('forma:archive', async () => archiveInfo());
ipcMain.handle('forma:help',async(_event,target)=>{
  const links={guide:'https://github.com/Forma2Acc/forma/blob/main/GUIDE.md',license:'https://github.com/Forma2Acc/forma/blob/main/LICENSE',support:'https://discord.gg/MqwFSTEdkF'};
  if(!Object.hasOwn(links,target))throw Error('Unknown help page.');
  await shell.openExternal(links[target]);return true;
});
async function resolveCodeRelease() {
  try {
    const r = await fetch(`${releaseConfig.apiUrl}/v1/code/releases/latest`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const env = await r.json();
      if (env?.payload && env?.signature) {
        const ok = crypto.verify(
          null,
          Buffer.from(`FORMA-CODE-UPDATE-v1\n${env.payload}`, 'utf8'),
          crypto.createPublicKey(releaseConfig.updatePublicKey),
          Buffer.from(env.signature, 'base64url'),
        );
        if (!ok) throw new Error('Signed Forma Code release verification failed.');
        const p = JSON.parse(env.payload);
        if (p?.url && p?.sha256) return { version: p.version, url: p.url, sha256: String(p.sha256).toLowerCase() };
      }
    }
  } catch (e) {
    if (/verification/i.test(e?.message || '')) throw e;
  }
  const gh = await fetch(`https://api.github.com/repos/${releaseConfig.github?.owner || 'Forma2Acc'}/${releaseConfig.github?.repo || 'forma'}/releases?per_page=15`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Forma-Launcher' },
    signal: AbortSignal.timeout(12000),
  });
  if (!gh.ok) throw new Error(`Release catalog unavailable (HTTP ${gh.status}).`);
  const list = await gh.json();
  const rel = (Array.isArray(list) ? list : []).find((x) => !x.draft && String(x.tag_name || '').startsWith('forma-code-v'));
  if (!rel) throw new Error('No published Forma Code release found on GitHub.');
  const version = String(rel.tag_name).replace(/^forma-code-v/i, '');
  const exeAsset = (rel.assets || []).find((a) => /^FormaCode-Setup-.*\.exe$/i.test(a.name));
  const sumAsset = (rel.assets || []).find((a) => /^SHA256SUMS\.txt$/i.test(a.name));
  if (!exeAsset || !sumAsset) throw new Error('Release assets for Forma Code are incomplete.');
  const sums = await (await fetch(sumAsset.browser_download_url, { signal: AbortSignal.timeout(10000) })).text();
  const m = sums.match(/([a-f0-9]{64})\s+FormaCode-Setup-/i);
  if (!m) throw new Error('SHA-256 digest missing from Forma Code release.');
  return { version, url: exeAsset.browser_download_url, sha256: m[1].toLowerCase() };
}

async function launchFormaCode() {
  license.requireActive();
  if (IS_LINUX) throw new Error('Forma Code desktop installer is currently Windows-only.');
  const dir = resolveCodeDir();
  const exe = path.join(dir, 'Forma Code.exe');
  if (!exists(exe)) throw new Error('Forma Code is not installed yet.');
  const child = spawn(exe, [], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true };
}

async function installFormaCodePipeline(options = {}) {
  if (IS_LINUX) return { ok: false, error: 'Forma Code is currently packaged for Windows.' };
  const job = createJob('code-install', ['Check latest release', 'Download installer', 'Verify SHA-256', 'Install Forma Code']);
  try {
    job.begin(0);
    const rel = await resolveCodeRelease();
    const cur = await detectFormaCode();
    if (!options.force && cur.installed && cur.version && !newer(rel.version, cur.version)) {
      job.done(0, `v${cur.version} up to date`);
      job.done(1, 'Skipped');
      job.done(2, 'Verified');
      if (options.launch) await launchFormaCode();
      job.done(3, options.launch ? 'Launched' : 'Ready');
      job.finish(`Forma Code v${cur.version} is already up to date.`);
      return { ok: true, version: cur.version, upToDate: true };
    }
    job.done(0, `v${rel.version}`);

    job.begin(1, 'Downloading FormaCode-Setup-' + rel.version + '.exe');
    const tmpDir = path.join(app.getPath('temp'), 'forma-code-stage');
    await fsp.mkdir(tmpDir, { recursive: true });
    const installerPath = path.join(tmpDir, `FormaCode-Setup-${rel.version}.exe`);
    const dl = await fetch(rel.url, { signal: AbortSignal.timeout(180000) });
    if (!dl.ok) throw new Error(`Download failed (HTTP ${dl.status}).`);
    const buf = Buffer.from(await dl.arrayBuffer());
    await rawFs.promises.writeFile(installerPath, buf);
    job.done(1, `${(buf.length / 1048576).toFixed(1)} MB downloaded`);

    job.begin(2);
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
    if (actualSha !== rel.sha256) throw new Error('Installer SHA-256 verification failed.');
    job.done(2, actualSha.slice(0, 12) + ' …');

    job.begin(3, 'Closing Forma Code & running silent setup');
    if (await codeRunning()) {
      await exec('taskkill', ['/F', '/T', '/IM', 'Forma Code.exe']).catch(() => {});
      await new Promise((r) => setTimeout(r, 900));
    }
    const inst = await exec(installerPath, ['/S'], { timeout: 180000 });
    await rawFs.promises.unlink(installerPath).catch(() => {});
    if (inst.code !== 0 && !exists(CODE_EXE)) throw new Error(`Setup exited with code ${inst.code}`);
    if (options.launch) await launchFormaCode();
    job.done(3, `Forma Code v${rel.version} installed`);
    job.finish(`Forma Code v${rel.version} installed & verified.`);
    setTimeout(() => collectLauncherTelemetry({ fast: false }).catch(() => {}), 500);
    return { ok: true, version: rel.version };
  } catch (error) {
    const index = job.steps.findIndex((s) => s.state === 'active');
    job.fail(index < 0 ? 0 : index, error.message);
    return { ok: false, error: error.message };
  }
}

license.on('commands', async (cmds) => {
  for (const cmd of cmds || []) {
    let ok = true, detail = 'done';
    try {
      if (cmd.type === 'install_update') {
        await updater.check({ autoDownload: true });
        if (!busy && exists(QWEN_EXE)) {
          const r = await installPipeline({ launch: false });
          detail = r.ok ? 'qwen updated' : (r.error || 'install failed');
          if (!r.ok) ok = false;
        }
      } else if (cmd.type === 'install_code_update') {
        const r = await installFormaCodePipeline({ launch: false });
        detail = r.ok ? `code v${r.version || 'latest'}` : (r.error || 'code install failed');
        if (!r.ok) ok = false;
      } else if (cmd.type === 'update_apps') {
        await updater.check({ autoDownload: true });
        if (!busy && exists(QWEN_EXE)) await installPipeline({ launch: false }).catch(() => {});
        const cr = await installFormaCodePipeline({ launch: false });
        detail = cr.ok ? 'apps synced' : (cr.error || 'partial update');
      } else if (cmd.type === 'check_update') {
        await updater.check({ autoDownload: true });
        detail = 'checked';
      } else if (cmd.type === 'refresh_license') {
        const s = await license.check(true);
        detail = `status=${s.status}`;
      }
    } catch (e) {
      ok = false; detail = e?.message || 'command failed';
    }
    await license.ackCommand?.(cmd.cmdId, ok, detail).catch(() => {});
  }
});

let codeAutoUpdateAttempted = false;
let claudeAutoUpdateAttempted = false;
license.on('change', (s) => {
  if (s?.status === 'active' && !codeAutoUpdateAttempted && (settings.autoUpdateApps || s?.policy?.autoUpdateApps)) {
    codeAutoUpdateAttempted = true;
    if (!IS_LINUX && exists(CODE_EXE)) {
      setTimeout(() => {
        if (!busy) installFormaCodePipeline({ launch: false }).catch(() => {});
      }, 15000).unref?.();
    }
  }
  if (s?.status === 'active' && !claudeAutoUpdateAttempted && (settings.autoUpdateApps || s?.policy?.autoUpdateApps)) {
    claudeAutoUpdateAttempted = true;
    if (!IS_LINUX) {
      setTimeout(() => {
        if (!busy) installClaudePipeline({ launch: false }).catch(() => {});
      }, 22000).unref?.();
    }
  }
});

ipcMain.handle('forma:install', guarded((options) => installPipeline(options || {})));
ipcMain.handle('forma:code-install', guarded((options) => installFormaCodePipeline(options || {})));
ipcMain.handle('forma:code-launch', guarded(async () => launchFormaCode()));
ipcMain.handle('forma:claude-install', guarded((options) => installClaudePipeline(options || {})));
ipcMain.handle('forma:claude-launch', guarded(async () => launchClaude()));
ipcMain.handle('forma:claude-restore', guarded(async () => restoreClaude()));
ipcMain.handle('forma:claude-state', async () => ({ claude: await detectClaude() }));
ipcMain.handle('forma:claude-key', async () => {
  const info = claudeKeyInfo();
  const url = info.device ? `${CLAUDE_KEY_URL}?installation=${encodeURIComponent(info.device)}` : CLAUDE_KEY_URL;
  await shell.openExternal(url);
  return { ok: true, url };
});
ipcMain.handle('forma:claude-key-info', async () => claudeKeyInfo());
ipcMain.handle('forma:claude-activate', guarded(async (_event, key) => {
  const result = writeClaudeHandoff(key);
  const current = await detectClaude();
  if (current.installed && !current.running) {
    await launchClaude().catch(() => {});
  }
  return { ...result, launched: current.installed && !current.running };
}));
ipcMain.handle('forma:claude-download', async () => {
  await shell.openExternal('https://claude.ai/download');
  return { ok: true, url: 'https://claude.ai/download' };
});
ipcMain.handle('forma:claude-open', async (_event, target) => {
  const allowed = {
    dir: CLAUDE_DIR,
    archive: CLAUDE_ARCHIVE,
    exe: path.join(claudeBaseDir() || CLAUDE_DIR, CLAUDE_EXE_NAME),
  };
  const resolved = allowed[target];
  if (!resolved || !exists(resolved)) return { ok: false, error: 'Path not available.' };
  await shell.openPath(resolved);
  return { ok: true };
});
ipcMain.handle('forma:update-all', guarded(async () => {
  const qRes = exists(QWEN_EXE) ? await installPipeline({ launch: false }) : { ok: true, skipped: true };
  const cRes = await installFormaCodePipeline({ launch: false });
  const clRes = await installClaudePipeline({ launch: false });
  await updater.check({ autoDownload: true }).catch(() => {});
  return { ok: Boolean(qRes.ok && cRes.ok && clRes.ok), qwen: qRes, code: cRes, claude: clRes };
}));
ipcMain.handle('forma:restore', guarded(() => restorePipeline()));
ipcMain.handle('forma:connections',guarded(async()=>{if(!exists(QWEN_EXE)||await hashFile(QWEN_ASAR)!==require('./payload-manifest.json')['Forma.asar']){const r=await installPipeline({launch:false});if(!r.ok)return r;}await launchQwen(['--forma-connections']);return {ok:true};}));
ipcMain.handle('forma:launch', guarded(async () => { await launchQwen(); return { ok: true }; }));
ipcMain.handle('forma:settings', async (_event, update) => {
  if (update && typeof update === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof update[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = update[key];
    }
    await saveSettings();
    applyMaterial();
  }
  return settings;
});
ipcMain.handle('forma:reveal', async (_event, target) => {
  const allowed = {
    project: PROJECT_DIR,
    source: path.join(PROJECT_DIR, 'source'),
    qwen: QWEN_DIR,
    archive: path.join(QWEN_DATA, 'forma'),
    workspace: path.join(QWEN_DATA, 'forma', 'workspace'),
    runtime: RUNTIME_DIR,
    claude: CLAUDE_DIR,
    claudeArchive: CLAUDE_ARCHIVE
  };
  const resolved = allowed[target];
  if (!resolved) return { ok: false, error: 'Unknown path.' };
  await shell.openPath(resolved);
  return { ok: true };
});
ipcMain.handle('forma:window', (_event, action) => {
  if (!window) return { ok: false };
  if (action === 'minimize') window.minimize();
  else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (action === 'close') window.close();
  else if (action === 'hide') window.hide();
  return { ok: true, maximized: window.isMaximized() };
});
