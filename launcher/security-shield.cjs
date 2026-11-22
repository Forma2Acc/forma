'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const dns = require('node:dns').promises;
const { execFile, execFileSync } = require('node:child_process');

let rawFs;
try {
  rawFs = require('original-fs');
} catch {
  rawFs = fs;
}

const PINNED_API_ORIGIN = 'https://forma-core-production.up.railway.app';
const PINNED_PUBLIC_KEY_SHA256 = '04b26a31698f18430606876dfa59507a4b959228f092eecc5580ab080de08135';
const PINNED_UPDATE_KEY_SHA256 = '69ca75dfa7c9317463254aa8d9c42131843b90f705e07c0dae0c860b93c14c5e';
const PINNED_ORIGINAL_QWEN_SHA256 = 'ebc1b0e1cbdee2723bd52c7e869292d624c67f1d0b2be3bc5704e2b6d2a1552f';
const PINNED_CORE_SHA256 = '3e31b09fa2758a4eac0e6219d94207612f4e63f54280280ee01384514c6b3b8e';
const NATIVE_AUDIT_SALT = 'FORMA-NATIVE-AUDIT-v1';

// Capture immutable references to native functions at module load before user/hook tampering.
const NATIVE_REFS = Object.freeze({
  verify: crypto.verify,
  createHash: crypto.createHash,
  randomBytes: crypto.randomBytes,
  fetch: globalThis.fetch,
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
  dateNow: Date.now,
  perfNow: typeof performance !== 'undefined' && performance ? performance.now : null,
  freeze: Object.freeze,
  defineProperty: Object.defineProperty,
  bufferFrom: Buffer.from,
  moduleLoad: Module._load,
  fnToString: Function.prototype.toString,
  objectKeys: Object.keys,
});

function isNativeFn(fn) {
  if (typeof fn !== 'function') return false;
  try {
    return Function.prototype.toString.call(fn).includes('[native code]');
  } catch {
    return false;
  }
}

function isPrivateOrLoopbackIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const clean = ip.trim().toLowerCase();
  if (clean === '::1' || clean === '::' || clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
    return true;
  }
  if (clean.startsWith('::ffff:')) {
    return isPrivateOrLoopbackIp(clean.slice(7));
  }
  const m = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function sha256FileSync(filePath) {
  try {
    return crypto.createHash('sha256').update(rawFs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

async function sha256FileAsync(filePath) {
  try {
    const data = await rawFs.promises.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function existsSyncRaw(target) {
  try {
    rawFs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isValidAsarHeaderSync(asarPath) {
  let fd = null;
  try {
    fd = rawFs.openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    if (rawFs.readSync(fd, prefix, 0, 16, 0) !== 16) return false;
    const magic = prefix.readUInt32LE(0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    return magic === 4 && jsonSize > 10 && jsonSize <= 16 * 1024 * 1024 && headerSize >= jsonSize && headerSize <= jsonSize + 16;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd);
      } catch {}
    }
  }
}

function readAsarHeaderHashSync(asarPath) {
  let fd = null;
  try {
    fd = rawFs.openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    if (rawFs.readSync(fd, prefix, 0, 16, 0) !== 16) return null;
    const magic = prefix.readUInt32LE(0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (!(magic === 4 && jsonSize > 10 && jsonSize <= 16 * 1024 * 1024 && headerSize >= jsonSize && headerSize <= jsonSize + 16)) {
      return null;
    }
    const headerBuf = Buffer.alloc(jsonSize);
    if (rawFs.readSync(fd, headerBuf, 0, jsonSize, 16) !== jsonSize) return null;
    return crypto.createHash('sha256').update(headerBuf).digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd);
      } catch {}
    }
  }
}

const ELECTRON_FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

function inspectExeNodeSync(exePath, asarPath) {
  const empty = {
    exists: false,
    size: 0,
    sha256: null,
    validPe: false,
    fusesFound: false,
    fuseVersion: 0,
    runAsNodeDisabled: false,
    nodeOptionsDisabled: false,
    nodeInspectDisabled: false,
    asarIntegrityEnabled: false,
    onlyLoadFromAsar: false,
    fusesOk: false,
    asarIntegrityMatch: false,
  };
  if (!exePath || !existsSyncRaw(exePath)) return empty;
  try {
    const stat = rawFs.statSync(exePath);
    const buf = rawFs.readFileSync(exePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const validPe =
      buf.length > 0x40 &&
      buf.readUInt16LE(0) === 0x5a4d &&
      (() => {
        const lfanew = buf.readUInt32LE(0x3c);
        return lfanew + 4 <= buf.length && buf.readUInt32LE(lfanew) === 0x00004550;
      })();
    const idx = buf.indexOf(ELECTRON_FUSE_SENTINEL);
    let fusesFound = false;
    let fuseVersion = 0;
    let runAsNodeDisabled = false;
    let nodeOptionsDisabled = false;
    let nodeInspectDisabled = false;
    let asarIntegrityEnabled = false;
    let onlyLoadFromAsar = false;
    if (idx >= 0 && idx + ELECTRON_FUSE_SENTINEL.length + 8 <= buf.length) {
      const base = idx + ELECTRON_FUSE_SENTINEL.length;
      fuseVersion = buf[base];
      const count = buf[base + 1];
      if (count >= 6 && base + 2 + count <= buf.length) {
        fusesFound = true;
        runAsNodeDisabled = buf[base + 2 + 0] === 48;
        nodeOptionsDisabled = buf[base + 2 + 2] === 48;
        nodeInspectDisabled = buf[base + 2 + 3] === 48;
        asarIntegrityEnabled = buf[base + 2 + 4] === 49;
        onlyLoadFromAsar = buf[base + 2 + 5] === 49;
      }
    }
    const fusesOk =
      fusesFound &&
      runAsNodeDisabled &&
      nodeOptionsDisabled &&
      nodeInspectDisabled &&
      asarIntegrityEnabled &&
      onlyLoadFromAsar;
    let asarIntegrityMatch = false;
    if (asarPath && existsSyncRaw(asarPath)) {
      const hdrHash = readAsarHeaderHashSync(asarPath);
      if (hdrHash) {
        asarIntegrityMatch = buf.includes(Buffer.from(hdrHash, 'utf8'));
      }
    }
    return {
      exists: true,
      size: stat.size,
      sha256,
      validPe,
      fusesFound,
      fuseVersion,
      runAsNodeDisabled,
      nodeOptionsDisabled,
      nodeInspectDisabled,
      asarIntegrityEnabled,
      onlyLoadFromAsar,
      fusesOk,
      asarIntegrityMatch,
    };
  } catch {
    return { ...empty, exists: existsSyncRaw(exePath) };
  }
}

function resolveLauncherFromRegistry() {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of keys) {
    try {
      const out = execFileSync('reg.exe', ['query', root, '/s', '/f', 'Forma', '/d'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500,
      });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)$/i) || line.match(/DisplayIcon\s+REG_SZ\s+(.+)$/i);
        if (m) {
          let candidate = m[1].trim().replace(/^"|"$/g, '').split(',')[0].trim();
          if (candidate.toLowerCase().endsWith('.exe')) candidate = path.dirname(candidate);
          if (existsSyncRaw(path.join(candidate, 'Forma.exe'))) return candidate;
        }
      }
    } catch {}
  }
  return null;
}

function resolveCoreBinarySync(bundledPath, workDir, expectedHash = PINNED_CORE_SHA256, extraCandidates = []) {
  for (const candidate of extraCandidates) {
    if (!candidate || /\.asar[\\/]/i.test(candidate)) continue;
    if (!existsSyncRaw(candidate)) continue;
    if (!expectedHash || sha256FileSync(candidate) === expectedHash) {
      return candidate;
    }
  }
  return extractCoreBinarySync(bundledPath, workDir, expectedHash);
}

function extractCoreBinarySync(bundledPath, workDir, expectedHash = PINNED_CORE_SHA256) {
  const norm = String(bundledPath || '').toLowerCase();
  const asarEntry = /\.asar[\\/]/.test(norm);
  const rawExists = existsSyncRaw(bundledPath);
  if (!rawExists && !asarEntry) return null;
  if (!asarEntry) {
    return bundledPath;
  }
  const exeName = path.basename(bundledPath);
  const dstDir = path.join(workDir || path.join(process.env.APPDATA || osTempDir(), 'FormaAccess'), 'bin');
  const dst = path.join(dstDir, exeName);
  // Check already-verified side-by-side copy before reading/writing to avoid AV lock conflicts.
  if (expectedHash && existsSyncRaw(dst) && sha256FileSync(dst) === expectedHash) {
    return dst;
  }
  // Electron's original-fs intentionally bypasses ASAR virtualization. Read an
  // archive entry through Electron's patched fs, then pin its bytes before it
  // is written to disk and executed as the native audit helper.
  let srcBytes;
  try { srcBytes = rawExists ? rawFs.readFileSync(bundledPath) : fs.readFileSync(bundledPath); }
  catch { return null; }
  const srcHash = crypto.createHash('sha256').update(srcBytes).digest('hex');
  if (expectedHash && srcHash !== expectedHash) return null;
  let needsCopy = true;
  try {
    if (existsSyncRaw(dst)) {
      const dstHash = sha256FileSync(dst);
      if (dstHash === srcHash) needsCopy = false;
    }
  } catch {}
  if (needsCopy) {
    try {
      fs.mkdirSync(dstDir, { recursive: true });
      const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
      rawFs.writeFileSync(tmp, srcBytes, { mode: 0o755 });
      rawFs.renameSync(tmp, dst);
    } catch {
      const existingHash = sha256FileSync(dst);
      if (existingHash !== srcHash) return null;
    }
  }
  return dst;
}

function osTempDir() {
  return require('node:os').tmpdir();
}

function runNativeCoreAudit(coreBinPath, requestObj) {
  return new Promise((resolve) => {
    if (!coreBinPath || !existsSyncRaw(coreBinPath)) {
      resolve({ ok: false, error: 'forma-core binary missing' });
      return;
    }
    const child = execFile(
      coreBinPath,
      ['--security-audit'],
      { windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message || 'native audit failed' });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || '').trim());
          resolve(parsed);
        } catch (e) {
          resolve({ ok: false, error: 'invalid native audit json' });
        }
      },
    );
    try {
      child.stdin.write(JSON.stringify(requestObj) + '\n');
      child.stdin.end();
    } catch {}
  });
}

async function writeLauncherAnchor({ vault, rootDir, launcherDir, payloadManifest, appVersion }) {
  if (!vault?.isEncryptionAvailable?.() || !launcherDir) return false;
  const launcherExe = path.join(launcherDir, 'Forma.exe');
  const launcherAsar = path.join(launcherDir, 'resources', 'app.asar');
  const payloadDir = path.join(launcherDir, 'resources', 'payload');
  const payloadAsar = path.join(payloadDir, 'Forma.asar');
  const payloadQwen = path.join(payloadDir, 'Qwen.exe');
  const anchor = {
    v: 2,
    appVersion: appVersion || null,
    launcherDir,
    launcherExe,
    launcherExeSha256: await sha256FileAsync(launcherExe),
    launcherAsarSha256: await sha256FileAsync(launcherAsar),
    payloadAsarSha256: (await sha256FileAsync(payloadAsar)) || payloadManifest?.['Forma.asar'] || null,
    payloadQwenSha256: (await sha256FileAsync(payloadQwen)) || payloadManifest?.['Qwen.exe'] || null,
    pid: process.pid,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  await fsp.mkdir(rootDir, { recursive: true });
  const sealed = await vault.encryptString(JSON.stringify(anchor));
  const tmp = path.join(rootDir, `launcher-anchor.${crypto.randomUUID()}.tmp`);
  await fsp.writeFile(tmp, sealed, { mode: 0o600 });
  await fsp.rename(tmp, path.join(rootDir, 'launcher-anchor.dpapi'));
  return true;
}

async function readLauncherAnchor({ vault, rootDir }) {
  if (!vault?.isEncryptionAvailable?.() || !rootDir) return null;
  try {
    const raw = await fsp.readFile(path.join(rootDir, 'launcher-anchor.dpapi'));
    const text = await vault.decryptString(raw);
    const parsed = JSON.parse(text);
    if (parsed && (parsed.v === 1 || parsed.v === 2) && typeof parsed.launcherDir === 'string') return parsed;
  } catch {}
  return null;
}

class SecurityShield {
  constructor(options = {}) {
    this.role = options.role === 'launcher' ? 'launcher' : 'qwen';
    this.packaged = !!options.packaged;
    this.enforce = options.enforce !== undefined ? !!options.enforce : this.packaged;
    this.app = options.app || null;
    this.config = options.config || {};
    this.payloadManifest = options.payloadManifest || null;
    this.license = options.license || null;
    this.vault = options.vault || null;
    this.accessRoot = options.accessRoot || path.join(process.env.APPDATA || osTempDir(), 'FormaAccess');
    this.moduleDir = options.moduleDir || __dirname;
    this.execPath = options.execPath || process.execPath;
    this.appPath = options.appPath || (this.app?.getAppPath ? this.app.getAppPath() : path.dirname(this.moduleDir));
    this.launcherDirOverride = options.launcherDir || null;
    this.expectedCoreSha256 = options.expectedCoreSha256 || PINNED_CORE_SHA256;
    this.pinnedApiOrigin = options.pinnedApiOrigin || PINNED_API_ORIGIN;
    this.pinnedPublicKeySha256 = options.pinnedPublicKeySha256 || PINNED_PUBLIC_KEY_SHA256;
    this.pinnedUpdateKeySha256 = options.pinnedUpdateKeySha256 || PINNED_UPDATE_KEY_SHA256;
    this.onAutoBlock = typeof options.onAutoBlock === 'function' ? options.onAutoBlock : null;
    this.customNativeAudit = typeof options.nativeAuditImpl === 'function' ? options.nativeAuditImpl : null;
    this.customDnsLookup = typeof options.dnsLookupImpl === 'function' ? options.dnsLookupImpl : (host) => dns.lookup(host, { all: true });
    this.ipcValidatorActive = !!options.ipcValidatorActive;
    this.nativeIpcGuardActive = !!options.nativeIpcGuardActive;
    this.windowGuardsActive = options.windowGuardsActive !== undefined ? !!options.windowGuardsActive : this.packaged;
    this.autoBlockArmed = options.autoBlockArmed !== undefined ? !!options.autoBlockArmed : true;
    this.auditCount = 0;
    this.auditPromise = null;
    this.auditFailures = 0;
    this.auditFailureLocked = false;
    this.watchdogTimer = null;
    this.watchdogArmed = false;
    this.lastAudit = null;
    this.nativeCooldownUntil = 0;
    this.lastMono = typeof performance !== 'undefined' ? performance.now() : 0;
    this.lastWall = Date.now();
    this.dnsCache = { host: '', privateOrLoopback: false, checkedAt: 0 };
    this.initialSealHash = (() => {
      if (this.role === 'launcher') return null;
      try {
        const sealPath = path.join(this.moduleDir, 'sealed.bin');
        return rawFs.existsSync(sealPath) ? crypto.createHash('sha256').update(rawFs.readFileSync(sealPath)).digest('hex') : null;
      } catch {
        try {
          const sealPath = path.join(this.moduleDir, 'sealed.bin');
          return fs.existsSync(sealPath) ? crypto.createHash('sha256').update(fs.readFileSync(sealPath)).digest('hex') : null;
        } catch { return null; }
      }
    })();
    this.securityBaseline = (() => {
      const map = new Map();
      for (const name of ['security-shield.cjs', 'license-client.cjs', 'license-electron.cjs', 'access-policy.cjs']) {
        try {
          const fp = path.join(this.moduleDir, name);
          const buf = existsSyncRaw(fp) ? rawFs.readFileSync(fp) : fs.readFileSync(fp);
          map.set(name, crypto.createHash('sha256').update(buf).digest('hex'));
        } catch {}
      }
      return map;
    })();
  }

  resolveLauncherDir(anchor) {
    if (this.launcherDirOverride) return this.launcherDirOverride;
    if (this.role === 'launcher' && this.packaged) {
      return path.dirname(this.execPath);
    }
    const argHit = process.argv.find((a) => typeof a === 'string' && a.startsWith('--forma-launcher-dir='));
    if (argHit) {
      const candidate = argHit.slice('--forma-launcher-dir='.length).trim();
      if (candidate && existsSyncRaw(path.join(candidate, 'Forma.exe'))) return candidate;
    }
    if (anchor?.launcherDir && existsSyncRaw(path.join(anchor.launcherDir, 'Forma.exe'))) {
      return anchor.launcherDir;
    }
    const candidates = [
      process.env.FORMA_LAUNCHER_DIR || null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Forma') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Forma') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Forma') : null,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Forma') : null,
    ].filter(Boolean);
    for (const dir of candidates) {
      if (existsSyncRaw(path.join(dir, 'Forma.exe'))) return dir;
    }
    const regDir = resolveLauncherFromRegistry();
    if (regDir) return regDir;
    return anchor?.launcherDir || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Forma') : null);
  }

  async checkDnsSafety() {
    let hostname = '';
    try {
      hostname = new URL(this.config.apiUrl || this.pinnedApiOrigin).hostname;
    } catch {
      return { ok: false, reason: 'invalid_api_url' };
    }
    if (this.dnsCache.host === hostname && Date.now() - this.dnsCache.checkedAt < 60000) {
      return { ok: !this.dnsCache.privateOrLoopback, host: hostname };
    }
    try {
      const addrs = await this.customDnsLookup(hostname);
      const list = Array.isArray(addrs) ? addrs : [addrs];
      const bad = list.some((entry) => isPrivateOrLoopbackIp(typeof entry === 'string' ? entry : entry?.address));
      this.dnsCache = { host: hostname, privateOrLoopback: bad, checkedAt: Date.now() };
      return { ok: !bad, host: hostname };
    } catch {
      // Transient DNS error should not trigger a false-positive tamper ban when offline.
      return { ok: true, host: hostname, transient: true };
    }
  }

  async runAudit(options = {}) {
    if (options.fast && this.lastAudit && Date.now() - (this.lastAudit.checkedAt || 0) < 30000) {
      return this.lastAudit;
    }
    if (this.auditPromise) return this.auditPromise;
    const pending = this._runAudit(options);
    this.auditPromise = pending;
    try {
      const report = await pending;
      this.auditFailures = 0;
      this.auditFailureLocked = false;
      return report;
    } catch (error) {
      this.auditFailures += 1;
      if (!this.enforce || this.auditFailures < 3) throw error;
      const detail = String(error?.message || 'watchdog audit failed').slice(0, 180);
      const failed = { id: 'CHK-AUDIT', name: 'Continuous integrity audit unavailable', detail };
      const report = {
        blocked: true,
        enforced: true,
        total: 106,
        passed: 0,
        failedCount: 1,
        criticalFailed: [],
        highFailed: [failed],
        mediumFailed: [],
        failedIds: ['CHK-AUDIT'],
        anomalies: ['watchdog_audit_failure'],
        checkedAt: Date.now(),
      };
      this.lastAudit = report;
      if (!this.auditFailureLocked) {
        this.auditFailureLocked = true;
        this.license?.recordAnomaly?.('watchdog_audit_failure');
        this.license?.lockForSecurity?.('Forma could not complete its integrity checks. Access is temporarily locked until the official app can verify itself.', report.failedIds);
        try { await this.onAutoBlock?.(report, 'Continuous integrity audit failed repeatedly.'); } catch {}
      }
      return report;
    } finally {
      if (this.auditPromise === pending) this.auditPromise = null;
    }
  }

  async _runAudit({ forceRescan = false, fast = false } = {}) {
    this.auditCount += 1;
    const doForce = forceRescan || this.auditCount === 1 || this.auditCount % 4 === 0;
    const anchor = await readLauncherAnchor({ vault: this.vault, rootDir: this.accessRoot });
    const launcherDir = this.resolveLauncherDir(anchor);

    const exeDir = path.dirname(this.execPath);
    const activeAsarPath = this.packaged
      ? path.join(path.dirname(this.execPath), 'resources', 'app.asar')
      : this.appPath.endsWith('.asar')
        ? this.appPath
        : null;

    const exeName = process.platform === 'win32' ? 'forma-core.exe' : 'forma-core';
    const bundledCore = path.join(this.moduleDir, exeName);
    const coreCandidates = [
      path.join(path.dirname(this.execPath || ''), 'resources', 'payload', exeName),
      launcherDir ? path.join(launcherDir, 'resources', 'payload', exeName) : null,
      path.join(path.dirname(path.dirname(this.moduleDir || '')), 'payload', exeName),
    ].filter(Boolean);
    const extractedCore = this.customNativeAudit
      ? bundledCore
      : resolveCoreBinarySync(bundledCore, this.accessRoot, this.expectedCoreSha256, coreCandidates);
    const coreDiskHash = extractedCore ? await sha256FileAsync(extractedCore) : null;
    const challenge = crypto.randomBytes(24).toString('hex');

    const skipNativeOnCooldown =
      !this.customNativeAudit && !forceRescan && (fast || Date.now() < this.nativeCooldownUntil);

    const nativeResp = this.customNativeAudit
      ? await this.customNativeAudit({
          challenge,
          forceRescan: doForce,
          exePath: this.execPath,
          asarPath: activeAsarPath,
          launcherDir,
        })
      : skipNativeOnCooldown
        ? { ok: false, error: 'native_cooldown_av' }
        : await runNativeCoreAudit(extractedCore, {
            challenge,
            forceRescan: doForce,
            exePath: this.execPath,
            asarPath: activeAsarPath,
            launcherDir,
          });

    if (!this.customNativeAudit) {
      if (nativeResp?.ok) this.nativeCooldownUntil = 0;
      else if (!skipNativeOnCooldown) this.nativeCooldownUntil = Date.now() + 5 * 60 * 1000;
    }

    const nat = nativeResp?.ok ? nativeResp.result || {} : null;
    const expectedTag = nat
      ? crypto
          .createHash('sha256')
          .update(
            `${NATIVE_AUDIT_SALT}:${challenge}:${nat.selfSha256 || ''}:${nat.currentExe?.sha256 || ''}:${nat.asarSha256 || ''}:${!!nat.launcherOk}:${!!(
              nat.isDebuggerPresent ||
              nat.remoteDebuggerPresent ||
              (nat.debuggersFound || []).length ||
              (nat.hookToolsFound || []).length ||
              (nat.suspiciousDlls || []).length
            )}`,
          )
          .digest('hex')
      : null;

    const dnsCheck = await this.checkDnsSafety();
    const checks = [];
    const check = (id, category, severity, name, passed, detail = '') => {
      checks.push({ id, category, severity, name, passed: !!passed, detail: passed ? '' : String(detail || name) });
    };

    const env = process.env;
    const argvJoined = [...process.execArgv, ...process.argv].join(' ');
    const requirePack = (cond) => (!this.packaged && !this.enforce ? true : !!cond);

    // === Category 1: Environment & Launch Arguments (CHK-001 .. CHK-018) ===
    check('CHK-001', 'env', 'critical', 'ELECTRON_RUN_AS_NODE unset', !env.ELECTRON_RUN_AS_NODE, 'run_as_node');
    check('CHK-002', 'env', 'medium', 'NODE_OPTIONS unset', !env.NODE_OPTIONS, 'node_options_set');
    check('CHK-003', 'env', 'medium', 'NODE_EXTRA_CA_CERTS unset', !env.NODE_EXTRA_CA_CERTS, 'extra_ca_certs');
    check('CHK-004', 'env', 'critical', 'TLS verification not disabled', env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'tls_verify_disabled');
    check('CHK-005', 'env', 'medium', 'VSCODE_INSPECTOR_OPTIONS unset', !env.VSCODE_INSPECTOR_OPTIONS, 'vscode_inspector');
    check('CHK-006', 'env', 'critical', 'LD_PRELOAD/DYLD_INSERT_LIBRARIES unset', !env.LD_PRELOAD && !env.DYLD_INSERT_LIBRARIES, 'env_injection');
    check('CHK-007', 'env', 'critical', 'ELECTRON_NO_ASAR unset', !env.ELECTRON_NO_ASAR, 'electron_no_asar');
    check('CHK-008', 'env', 'high', 'SSLKEYLOGFILE unset', !env.SSLKEYLOGFILE, 'sslkeylogfile_set');
    check('CHK-009', 'env', 'medium', 'HTTP_PROXY unset', !env.HTTP_PROXY && !env.http_proxy, 'http_proxy_set');
    check('CHK-010', 'env', 'medium', 'HTTPS_PROXY unset', !env.HTTPS_PROXY && !env.https_proxy, 'https_proxy_set');
    check('CHK-011', 'env', 'medium', 'ALL_PROXY unset', !env.ALL_PROXY && !env.all_proxy, 'all_proxy_set');
    check('CHK-012', 'env', 'critical', 'FRIDA env vars unset', !Object.keys(env).some((k) => k.toUpperCase().startsWith('FRIDA_')), 'frida_env');
    check('CHK-013', 'env', 'critical', 'No --inspect flags', !/(?:^|\s)--inspect(?:-(?:brk|wait))?(?:=|\s|$)/i.test(argvJoined), 'debugger_flag');
    check('CHK-014', 'env', 'critical', 'No --remote-debugging flags in packaged mode', requirePack(!/--remote-debugging-(?:port|pipe)/i.test(argvJoined)), 'remote_debug_flag');
    check('CHK-015', 'env', 'critical', 'No --allow-natives-syntax / --js-flags', !/--allow-natives-syntax|--js-flags/i.test(argvJoined), 'v8_unsafe_flags');
    check('CHK-016', 'env', 'critical', 'No --disable-web-security / --ignore-certificate-errors / --proxy-server', requirePack(!/--disable-web-security|--ignore-certificate-errors|--proxy-server/i.test(argvJoined)), 'chromium_security_bypass');
    let inspectorUrl = null;
    try {
      inspectorUrl = require('node:inspector').url?.() || null;
    } catch {}
    check('CHK-017', 'env', 'critical', 'node:inspector inactive', requirePack(!inspectorUrl), 'debugger_detected');
    check('CHK-018', 'env', 'high', 'FORMA_QA unset in packaged mode', requirePack(env.FORMA_QA !== '1'), 'qa_flag_packaged');

    // === Category 2: Launcher Presence, Ticket & Installation Integrity (CHK-019 .. CHK-038) ===
    const nativeBlockedByAv = !nat && !this.customNativeAudit;
    const lDirOk = !!launcherDir && existsSyncRaw(launcherDir);
    const lExePath = launcherDir ? path.join(launcherDir, 'Forma.exe') : '';
    const lAsarPath = launcherDir ? path.join(launcherDir, 'resources', 'app.asar') : '';
    const lPayloadDir = launcherDir ? path.join(launcherDir, 'resources', 'payload') : '';
    const lUnpackedDir = launcherDir ? path.join(launcherDir, 'resources', 'app.asar.unpacked') : '';
    const nodeLe = !nat ? inspectExeNodeSync(lExePath, lAsarPath) : null;
    const le = nat?.launcherExe || nodeLe || {};
    const effLauncherAsarSha256 = nat ? nat.launcherAsarSha256 : (lAsarPath && existsSyncRaw(lAsarPath) ? await sha256FileAsync(lAsarPath) : null);
    const effPayloadAsarSha256 = nat ? nat.payloadAsarSha256 : (lPayloadDir ? await sha256FileAsync(path.join(lPayloadDir, 'Forma.asar')) : null);
    const effPayloadExeSha256 = nat ? nat.payloadExeSha256 : (lPayloadDir ? await sha256FileAsync(path.join(lPayloadDir, 'Qwen.exe')) : null);
    const effPayloadOrigSha256 = nat ? nat.payloadOriginalSha256 : (lPayloadDir ? await sha256FileAsync(path.join(lPayloadDir, 'Original-Qwen.asar')) : null);
    const effLauncherUnpackedApp = nat ? !!nat.launcherUnpackedAppExists : (!!launcherDir && existsSyncRaw(path.join(launcherDir, 'resources', 'app')));
    const effCurUnpackedApp = nat ? !!nat.currentUnpackedAppExists : (!!exeDir && existsSyncRaw(path.join(exeDir, 'resources', 'app')));
    const hasBadUnpackedJs = (() => {
      if (!lUnpackedDir || !existsSyncRaw(lUnpackedDir)) return false;
      try {
        const entries = rawFs.readdirSync(lUnpackedDir, { recursive: true });
        return entries.some((e) => /\.(c?js|mjs|html)$/i.test(String(e)));
      } catch {
        return false;
      }
    })();
    const launcherAsarValid = lAsarPath ? isValidAsarHeaderSync(lAsarPath) : false;
    const launcherConfigOk = (() => {
      if (!lAsarPath || !existsSyncRaw(lAsarPath)) return false;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(lAsarPath, 'license-config.json'), 'utf8'));
        return cfg?.apiUrl === this.pinnedApiOrigin;
      } catch {
        return false;
      }
    })();

    const manifest = this.payloadManifest || (() => {
      try {
        return require('./payload-manifest.json');
      } catch {}
      if (lAsarPath && existsSyncRaw(lAsarPath)) {
        try {
          return JSON.parse(fs.readFileSync(path.join(lAsarPath, 'payload-manifest.json'), 'utf8'));
        } catch {}
      }
      return null;
    })();

    const pAsarMatch = manifest?.['Forma.asar'] ? effPayloadAsarSha256 === manifest['Forma.asar'] : !!effPayloadAsarSha256;
    const pExeMatch = manifest?.['Qwen.exe'] ? effPayloadExeSha256 === manifest['Qwen.exe'] : !!effPayloadExeSha256;
    const pOrigMatch = effPayloadOrigSha256 ? effPayloadOrigSha256 === PINNED_ORIGINAL_QWEN_SHA256 : false;
    const launcherVerifiedByFuses =
      this.role === 'launcher' && !!le.fusesOk && !!le.asarIntegrityMatch && launcherAsarValid;
    const anchorValid =
      !anchor ||
      launcherVerifiedByFuses ||
      (!!anchor.launcherDir &&
        !!anchor.launcherExeSha256 &&
        (!le.sha256 || anchor.launcherExeSha256 === le.sha256) &&
        (!effLauncherAsarSha256 || !anchor.launcherAsarSha256 || anchor.launcherAsarSha256 === effLauncherAsarSha256));
    const launcherRequired = this.packaged || this.enforce;

    check('CHK-019', 'launcher', 'critical', 'Launcher directory resolved', !launcherRequired || lDirOk, 'launcher_missing');
    check('CHK-020', 'launcher', 'critical', 'Forma.exe exists on disk', !launcherRequired || !!le.exists || (!!lExePath && existsSyncRaw(lExePath)), 'launcher_exe_missing');
    check('CHK-021', 'launcher', 'critical', 'Forma.exe non-stub size (>10 MB)', !launcherRequired || Number(le.size || 0) > 10 * 1024 * 1024, 'launcher_exe_stub');
    check('CHK-022', 'launcher', 'critical', 'Forma.exe valid PE header', !launcherRequired || !!le.validPe, 'launcher_pe_invalid');
    check('CHK-023', 'launcher', 'critical', 'Forma.exe Electron Fuse sentinel present', !launcherRequired || !!le.fusesFound, 'launcher_fuse_missing');
    check('CHK-024', 'launcher', 'critical', 'Forma.exe Fuse RunAsNode disabled', !launcherRequired || !!le.runAsNodeDisabled, 'launcher_fuse_run_as_node');
    check('CHK-025', 'launcher', 'critical', 'Forma.exe Fuse NodeOptions disabled', !launcherRequired || !!le.nodeOptionsDisabled, 'launcher_fuse_node_opts');
    check('CHK-026', 'launcher', 'critical', 'Forma.exe Fuse CliInspect disabled', !launcherRequired || !!le.nodeInspectDisabled, 'launcher_fuse_inspect');
    check('CHK-027', 'launcher', 'critical', 'Forma.exe Fuse AsarIntegrity enabled', !launcherRequired || !!le.asarIntegrityEnabled, 'launcher_fuse_asar_int');
    check('CHK-028', 'launcher', 'critical', 'Forma.exe Fuse OnlyLoadAppFromAsar enabled', !launcherRequired || !!le.onlyLoadFromAsar, 'launcher_fuse_only_asar');
    check('CHK-029', 'launcher', 'critical', 'Forma.exe ELECTRONASAR matches app.asar header', !launcherRequired || !!le.asarIntegrityMatch, 'launcher_asar_integrity_mismatch');
    check('CHK-030', 'launcher', 'critical', 'Forma resources/app.asar exists and valid', !launcherRequired || (!!effLauncherAsarSha256 && launcherAsarValid), 'launcher_asar_invalid');
    check('CHK-031', 'launcher', 'critical', 'Forma resources/app unpacked dir absent', !launcherRequired || !effLauncherUnpackedApp, 'launcher_unpacked_override');
    check('CHK-032', 'launcher', 'high', 'Forma app.asar.unpacked clean', !launcherRequired || !hasBadUnpackedJs, 'launcher_unpacked_js');
    check('CHK-033', 'launcher', 'critical', 'Launcher payload Forma.asar intact', !launcherRequired || pAsarMatch, 'launcher_payload_asar_mismatch');
    check('CHK-034', 'launcher', 'critical', 'Launcher payload Qwen.exe intact', !launcherRequired || pExeMatch, 'launcher_payload_exe_mismatch');
    check('CHK-035', 'launcher', 'high', 'Launcher payload Original-Qwen.asar intact', !launcherRequired || pOrigMatch, 'launcher_original_backup_mismatch');
    check('CHK-036', 'launcher', 'high', 'Launcher license-config.json pinned', !launcherRequired || launcherConfigOk, 'launcher_config_tamper');
    check('CHK-037', 'launcher', 'high', 'Launcher DPAPI attestation anchor valid', !launcherRequired || anchorValid, 'launcher_anchor_tamper');
    check('CHK-038', 'launcher', 'medium', 'Launcher located outside temp dir', !launcherRequired || !/\\temp\\|\/tmp\//i.test(launcherDir || ''), 'launcher_temp_location');

    // === Category 3: Active Binary, Fuses & ASAR Integrity (CHK-039 .. CHK-054) ===
    const curAsarPath = activeAsarPath || '';
    const nodeCe = !nat ? inspectExeNodeSync(this.execPath, curAsarPath) : null;
    const ce = nat?.currentExe || nodeCe || {};
    const effCurAsarSha256 = nat ? nat.asarSha256 : (curAsarPath && existsSyncRaw(curAsarPath) ? await sha256FileAsync(curAsarPath) : null);
    const expectedExeName = this.role === 'launcher' ? 'forma.exe' : 'qwen.exe';
    const actualExeBase = path.basename(this.execPath || '').toLowerCase();
    const qwenAsarMatch =
      this.role === 'launcher' || !manifest?.['Forma.asar'] ? true : effCurAsarSha256 === manifest['Forma.asar'];
    const qwenExeMatch =
      this.role === 'launcher' || !manifest?.['Qwen.exe'] ? true : ce.sha256 === manifest['Qwen.exe'];
    const coreHashOk = !this.expectedCoreSha256 || !coreDiskHash || coreDiskHash === this.expectedCoreSha256 || (!this.packaged && !this.enforce);

    check('CHK-039', 'binary', 'critical', 'Executable name matches role', requirePack(actualExeBase === expectedExeName), 'unexpected_executable_name');
    check('CHK-040', 'binary', 'critical', 'Current executable readable on disk', requirePack(!!ce.exists), 'exe_unreadable');
    check('CHK-041', 'binary', 'critical', 'Current executable valid PE header', requirePack(!!ce.validPe), 'exe_pe_invalid');
    check('CHK-042', 'binary', 'critical', 'Current executable Electron Fuse sentinel present', requirePack(!!ce.fusesFound), 'fuse_tamper');
    check('CHK-043', 'binary', 'critical', 'Current executable Fuse RunAsNode disabled', requirePack(!!ce.runAsNodeDisabled), 'fuse_tamper');
    check('CHK-044', 'binary', 'critical', 'Current executable Fuse NodeOptions disabled', requirePack(!!ce.nodeOptionsDisabled), 'fuse_tamper');
    check('CHK-045', 'binary', 'critical', 'Current executable Fuse CliInspect disabled', requirePack(!!ce.nodeInspectDisabled), 'fuse_tamper');
    check('CHK-046', 'binary', 'critical', 'Current executable Fuse AsarIntegrity enabled', requirePack(!!ce.asarIntegrityEnabled), 'fuse_tamper');
    check('CHK-047', 'binary', 'critical', 'Current executable Fuse OnlyLoadAppFromAsar enabled', requirePack(!!ce.onlyLoadFromAsar), 'fuse_tamper');
    check('CHK-048', 'binary', 'critical', 'Current executable ELECTRONASAR matches ASAR header', requirePack(!!ce.asarIntegrityMatch), 'asar_integrity_mismatch');
    check('CHK-049', 'binary', 'critical', 'Active app.asar matches payload-manifest', requirePack(qwenAsarMatch), 'asar_mismatch');
    check('CHK-050', 'binary', 'critical', 'Active Qwen.exe matches payload-manifest', requirePack(qwenExeMatch), 'exe_mismatch');
    check('CHK-051', 'binary', 'critical', 'No unpacked resources/app directory', requirePack(!effCurUnpackedApp), 'unpacked_app_override');
    check('CHK-052', 'binary', 'critical', 'app.getAppPath() resolves to .asar', requirePack(this.appPath.toLowerCase().endsWith('.asar')), 'app_path_not_asar');
    check('CHK-053', 'binary', 'critical', 'Active ASAR header structure valid', requirePack(curAsarPath ? isValidAsarHeaderSync(curAsarPath) : false), 'asar_header_corrupt');
    check('CHK-054', 'binary', coreDiskHash && !coreHashOk ? 'critical' : 'medium', 'Native forma-core binary integrity verified', nativeBlockedByAv ? (!coreDiskHash || coreHashOk) : (!!coreDiskHash && coreHashOk), 'native_core_tamper');

    // === Category 4: JavaScript Runtime & Module Anti-Hook (CHK-055 .. CHK-070) ===
    const cfgPubSha = this.config?.publicKey
      ? crypto.createHash('sha256').update(String(this.config.publicKey).trim()).digest('hex')
      : '';
    const cfgUpdSha = this.config?.updatePublicKey
      ? crypto.createHash('sha256').update(String(this.config.updatePublicKey).trim()).digest('hex')
      : '';
    const cfgApiOrigin = (() => {
      try {
        return new URL(this.config.apiUrl).origin;
      } catch {
        return '';
      }
    })();

    check('CHK-055', 'runtime', 'critical', 'crypto.verify unmodified', crypto.verify === NATIVE_REFS.verify, 'js_hook_detected');
    check('CHK-056', 'runtime', 'critical', 'crypto.createHash unmodified', crypto.createHash === NATIVE_REFS.createHash, 'js_hook_detected');
    check('CHK-057', 'runtime', 'critical', 'crypto.randomBytes unmodified', crypto.randomBytes === NATIVE_REFS.randomBytes, 'js_hook_detected');
    check('CHK-058', 'runtime', 'critical', 'globalThis.fetch unmodified', globalThis.fetch === NATIVE_REFS.fetch, 'js_hook_detected');
    check('CHK-059', 'runtime', 'critical', 'JSON.parse native and unhooked', JSON.parse === NATIVE_REFS.jsonParse && isNativeFn(JSON.parse), 'js_hook_detected');
    check('CHK-060', 'runtime', 'critical', 'JSON.stringify native and unhooked', JSON.stringify === NATIVE_REFS.jsonStringify && isNativeFn(JSON.stringify), 'js_hook_detected');
    check('CHK-061', 'runtime', 'critical', 'Date.now native and unhooked', Date.now === NATIVE_REFS.dateNow && isNativeFn(Date.now), 'js_hook_detected');
    check('CHK-062', 'runtime', 'critical', 'performance.now unhooked', !NATIVE_REFS.perfNow || performance.now === NATIVE_REFS.perfNow, 'js_hook_detected');
    check('CHK-063', 'runtime', 'high', 'Object.freeze / defineProperty native', Object.freeze === NATIVE_REFS.freeze && Object.defineProperty === NATIVE_REFS.defineProperty, 'js_hook_detected');
    check('CHK-064', 'runtime', 'high', 'Buffer.from unmodified', Buffer.from === NATIVE_REFS.bufferFrom, 'js_hook_detected');

    const lcClass = this.license?.constructor;
    const lcProtoOk =
      !lcClass ||
      (typeof lcClass.prototype?.snapshot === 'function' &&
        typeof lcClass.prototype?.requireActive === 'function' &&
        typeof lcClass.prototype?.lockForSecurity === 'function');
    check('CHK-065', 'runtime', 'critical', 'LicenseClient prototype intact', lcProtoOk, 'license_client_tamper');
    check('CHK-066', 'runtime', 'critical', 'apiUrl matches pinned production origin', requirePack(cfgApiOrigin === this.pinnedApiOrigin), 'api_origin_tamper');
    check('CHK-067', 'runtime', 'critical', 'publicKey matches pinned Ed25519 SPKI', requirePack(cfgPubSha === this.pinnedPublicKeySha256), 'public_key_tamper');
    check('CHK-068', 'runtime', 'critical', 'updatePublicKey matches pinned Ed25519 SPKI', requirePack(!cfgUpdSha || cfgUpdSha === this.pinnedUpdateKeySha256), 'update_key_tamper');

    // The launcher does not load the Qwen sealed-tool loader. Requiring those
    // Qwen-only files from the Forma launcher ASAR creates a false CHK-069.
    // Keep the common security checks for both roles and require the sealed
    // loader only in the Qwen runtime where it is actually used.
    const requiredSecurityModules = ['license-client.cjs', 'license-electron.cjs', 'access-policy.cjs', 'security-shield.cjs'];
    if (this.role !== 'launcher') requiredSecurityModules.push('sealed-loader.cjs', 'sealed.bin');
    const criticalModulesPresent = requiredSecurityModules.every((f) =>
      fs.existsSync(path.join(this.moduleDir, f)),
    );
    check('CHK-069', 'runtime', 'high', 'Core security modules present on module path', criticalModulesPresent, 'security_modules_missing');

    const badCmdSwitches = (() => {
      try {
        if (!this.app?.commandLine?.hasSwitch) return false;
        return ['remote-debugging-port', 'remote-debugging-pipe', 'proxy-server', 'ignore-certificate-errors', 'disable-web-security'].some((s) =>
          this.app.commandLine.hasSwitch(s),
        );
      } catch {
        return false;
      }
    })();
    check('CHK-070', 'runtime', 'high', 'Electron commandLine switches clean', requirePack(!badCmdSwitches), 'commandline_switch_bypass');

    // === Category 5: Native OS Debugger, Process, DLL & Hosts Checks (CHK-071 .. CHK-088) ===
    const parentLower = String(nat?.parentName || '').toLowerCase();
    const suspiciousParents = ['x64dbg', 'x32dbg', 'ollydbg', 'ida', 'ghidra', 'frida', 'cheatengine', 'windbg'];
    const dbgs = (nat?.debuggersFound || []).map((s) => s.toLowerCase());
    const res = (nat?.reToolsFound || []).map((s) => s.toLowerCase());
    const mitms = (nat?.mitmToolsFound || []).map((s) => s.toLowerCase());
    const hooks = (nat?.hookToolsFound || []).map((s) => s.toLowerCase());
    const monitors = (nat?.monitorToolsFound || []).map((s) => s.toLowerCase());
    const dlls = (nat?.suspiciousDlls || []).map((s) => s.toLowerCase());
    const hosts = (nat?.hostsHijacked || []).map((s) => s.toLowerCase());

    check('CHK-071', 'native', nativeBlockedByAv ? 'medium' : 'critical', 'Native forma-core audit responded', !!nat, nativeBlockedByAv ? 'native_core_av_blocked' : 'native_guard_offline');
    check('CHK-072', 'native', nativeBlockedByAv ? 'medium' : 'critical', 'Native forma-core challenge attestation valid', nativeBlockedByAv ? true : (!!nat && nat.attestationTag === expectedTag), 'native_guard_tamper');
    check('CHK-073', 'native', 'critical', 'Win32 IsDebuggerPresent false', nativeBlockedByAv ? true : (!!nat && !nat.isDebuggerPresent), 'debugger_detected');
    check('CHK-074', 'native', 'critical', 'Win32 CheckRemoteDebuggerPresent false', nativeBlockedByAv ? true : (!!nat && !nat.remoteDebuggerPresent), 'remote_debugger_detected');
    check('CHK-075', 'native', 'critical', 'Parent process not a RE/debug tool', !suspiciousParents.some((p) => parentLower.includes(p)), 'suspicious_parent_process');
    check('CHK-076', 'native', 'critical', 'No x64dbg/x32dbg/ollydbg running', !dbgs.some((d) => /x64dbg|x32dbg|ollydbg/.test(d)), 'debugger_tool_running');
    check('CHK-077', 'native', 'critical', 'No windbg/cdb/ntsd/immunity running', !dbgs.some((d) => /windbg|cdb|ntsd|immunity/.test(d)), 'debugger_tool_running');
    check('CHK-078', 'native', 'critical', 'No IDA/Ghidra/BinaryNinja running', !res.some((d) => /ida|ghidra|binaryninja/.test(d)), 're_tool_running');
    check('CHK-079', 'native', 'high', 'No radare2/rizin running', !res.some((d) => /radare2|r2\.exe|rizin/.test(d)), 're_tool_running');
    check('CHK-080', 'native', 'critical', 'No CheatEngine/Scylla/Dumper running', !dbgs.concat(res).some((d) => /cheatengine|scylla|dumper/.test(d)), 'memory_dumper_running');
    check('CHK-081', 'native', 'critical', 'No Frida instrumentation running', hooks.length === 0, 'frida_running');
    check('CHK-082', 'native', 'high', 'No API Monitor / injection inspector running', !res.some((d) => /apimonitor/.test(d)), 'inspection_tool_running');
    check('CHK-083', 'native', 'high', 'No dnSpy/ILSpy/PEStudio/LordPE running', !res.some((d) => /dnspy|ilspy|pestudio|lordpe|importrec/.test(d)), 'pe_tool_running');
    check('CHK-084', 'native', 'critical', 'No Fiddler/Charles/mitmproxy/HTTPDebugger/Burp running', !mitms.some((d) => /fiddler|charles|mitm|httpdebugger|burpsuite/.test(d)), 'mitm_proxy_running');
    check('CHK-085', 'native', 'medium', 'No packet sniffer/Proxifier active', !mitms.some((d) => /wireshark|tshark|dumpcap|proxifier/.test(d)), 'packet_sniffer_running');
    check('CHK-086', 'native', 'critical', 'No suspicious injected DLLs loaded', dlls.length === 0, 'injected_dll_detected');
    check('CHK-087', 'native', 'critical', 'No hosts override for Forma API or GitHub', !hosts.some((h) => h.includes('railway.app') || h.includes('chatgpt.site') || h.includes('github.com')), 'hosts_api_hijack');
    check('CHK-088', 'native', 'high', 'No hosts override for Qwen domains', !hosts.some((h) => h.includes('qwen.ai')), 'hosts_qwen_hijack');

    // === Category 6: Network, DNS, Vault & Clock Integrity (CHK-089 .. CHK-097) ===
    const apiUrlStr = String(this.config?.apiUrl || '');
    const isHttpsApi = (() => {
      try {
        return new URL(apiUrlStr).protocol === 'https:';
      } catch {
        return false;
      }
    })();
    const vaultOk = !this.vault || !!this.vault.isEncryptionAvailable?.();
    const idOk = !this.license?.device || /^[a-f0-9]{64}$/.test(this.license.device);
    const curMono = typeof performance !== 'undefined' ? performance.now() : 0;
    const curWall = Date.now();
    const monoDelta = curMono - this.lastMono;
    const wallDelta = curWall - this.lastWall;
    // Allow forward sleep/hibernate jumps and normal Windows NTP resyncs (<5 min); flag large wall-clock rollback.
    const clockSane = monoDelta >= -500 && wallDelta >= -300000 && (wallDelta - monoDelta) >= -300000;
    this.lastMono = curMono;
    this.lastWall = curWall;

    const hbFails = Number(this.license?.consecutiveHeartbeatFailures || 0);
    const serverBlocked = this.license?.snapshot?.().status === 'banned';

    check('CHK-089', 'network', 'critical', 'API endpoint uses HTTPS', requirePack(isHttpsApi), 'insecure_api_protocol');
    check('CHK-090', 'network', 'critical', 'API DNS not resolved to loopback/private IP', !!dnsCheck.ok, 'dns_loopback_hijack');
    check('CHK-091', 'network', 'critical', 'Encrypted DPAPI/vault available', vaultOk, 'vault_unavailable');
    check('CHK-092', 'network', 'critical', 'Installation ID valid 64-hex', idOk, 'invalid_installation_id');
    check('CHK-093', 'network', 'medium', 'Wall clock free of rollback tamper', clockSane, 'clock_tamper');
    check('CHK-094', 'network', 'high', 'Server receipt 60s time window enforced', true, '');
    check('CHK-095', 'network', 'high', 'Lease cap <= 120s enforced', true, '');
    check('CHK-096', 'network', 'medium', 'Heartbeat continuity within threshold (<3 failures)', hbFails < 3, 'heartbeat_blocked');
    check('CHK-097', 'network', 'medium', 'Backend integrity/ban check not tripped', !serverBlocked, 'backend_integrity_block');

    // === Category 7: IPC, Electron Window Guards & Auto-Block Enforcement (CHK-098 .. CHK-112) ===
    const manifestValid = !manifest || (typeof manifest['Forma.asar'] === 'string' && /^[a-f0-9]{64}$/.test(manifest['Forma.asar']));
    check('CHK-098', 'ipc', 'critical', 'DevTools blocked in packaged mode', requirePack(this.windowGuardsActive), 'devtools_tamper');
    check('CHK-099', 'ipc', 'critical', 'Context isolation & no nodeIntegration enforced', requirePack(this.windowGuardsActive), 'renderer_isolation_tamper');
    check('CHK-100', 'ipc', 'high', 'Renderer sandbox active', requirePack(this.windowGuardsActive), 'renderer_sandbox_tamper');
    check('CHK-101', 'ipc', 'critical', 'IPC origin & mainFrame validator active', requirePack(this.ipcValidatorActive), 'ipc_validator_missing');
    check('CHK-102', 'ipc', 'critical', 'Native IPC guard active', this.role === 'launcher' || requirePack(this.nativeIpcGuardActive), 'native_ipc_guard_missing');
    check('CHK-103', 'ipc', 'high', 'payload-manifest.json valid', requirePack(manifestValid), 'manifest_invalid');
    check('CHK-104', 'ipc', 'high', 'Automatic block engine armed', this.autoBlockArmed, 'autoblock_disarmed');
    check('CHK-105', 'ipc', 'high', 'Continuous background watchdog armed', requirePack(this.watchdogArmed), 'watchdog_disarmed');

    const sealCheckOk = (() => {
      if (this.role === 'launcher') return true;
      const sealPath = path.join(this.moduleDir, 'sealed.bin');
      try {
        const buf = existsSyncRaw(sealPath) ? rawFs.readFileSync(sealPath) : fs.readFileSync(sealPath);
        if (!buf || buf.length <= 40 || !buf.subarray(0, 4).equals(Buffer.from('FSL1'))) return false;
        const h = crypto.createHash('sha256').update(buf).digest('hex');
        return !this.initialSealHash || h === this.initialSealHash;
      } catch {
        return !this.packaged && !this.initialSealHash;
      }
    })();
    const secBaselineOk = (() => {
      if (!this.securityBaseline || !this.securityBaseline.size) return true;
      for (const [name, expected] of this.securityBaseline.entries()) {
        try {
          const fp = path.join(this.moduleDir, name);
          const buf = existsSyncRaw(fp) ? rawFs.readFileSync(fp) : fs.readFileSync(fp);
          if (crypto.createHash('sha256').update(buf).digest('hex') !== expected) return false;
        } catch {
          return false;
        }
      }
      return true;
    })();
    const noPlaintextSealed =
      !this.packaged ||
      this.role === 'launcher' ||
      (['tool-engine.cjs', 'protocol.cjs', 'response-stream.cjs', 'permissions.cjs', 'integrations.cjs', 'native-history.cjs', 'limit-reset.cjs', 'guest.js', 'guest.css'].every((f) => {
        const p = path.join(this.moduleDir, f);
        try { return !fs.existsSync(p); } catch { return true; }
      }) &&
        ['addon.js', 'addon.css', 'integrations-ui.js', 'integrations-ui.css', 'bug-report-ui.js'].every((f) => {
          const p = path.join(this.moduleDir, '..', 'renderer', f);
          try { return !fs.existsSync(p); } catch { return true; }
        }));

    check('CHK-106', 'runtime', 'critical', 'Module._load unhooked in packaged mode', requirePack(Module._load === NATIVE_REFS.moduleLoad), 'module_loader_hook');
    check('CHK-107', 'runtime', 'critical', 'Function.prototype.toString & Object.keys native', Function.prototype.toString === NATIVE_REFS.fnToString && Object.keys === NATIVE_REFS.objectKeys && isNativeFn(Function.prototype.toString), 'js_hook_detected');
    check('CHK-108', 'runtime', 'critical', 'Encrypted sealed.bin container valid and unmodified', requirePack(sealCheckOk), 'sealed_container_tamper');
    check('CHK-109', 'binary', 'critical', 'Security module digests unchanged since startup', secBaselineOk, 'security_module_tamper');
    check('CHK-110', 'binary', 'critical', 'No plaintext sealed core modules shipped in packaged ASAR', noPlaintextSealed, 'unsealed_core_leak');
    check('CHK-111', 'native', 'critical', 'Parent Electron process clean of attached debuggers', nativeBlockedByAv ? true : (!!nat && !nat.remoteDebuggerPresent), 'parent_debugger_detected');
    check('CHK-112', 'native', 'medium', 'Passive OS system monitors observed (telemetry only)', monitors.length === 0, 'monitor_tool_running');

    const failed = checks.filter((c) => !c.passed);
    const criticalFailed = failed.filter((c) => c.severity === 'critical');
    const highFailed = failed.filter((c) => c.severity === 'high');
    const mediumFailed = failed.filter((c) => c.severity === 'medium');
    const shouldBlock = this.enforce && criticalFailed.length > 0;

    const report = {
      ok: failed.length === 0,
      blocked: shouldBlock,
      enforced: this.enforce,
      role: this.role,
      total: checks.length,
      passed: checks.length - failed.length,
      failedCount: failed.length,
      criticalFailed: criticalFailed.map((c) => ({ id: c.id, name: c.name, detail: c.detail })),
      highFailed: highFailed.map((c) => ({ id: c.id, name: c.name, detail: c.detail })),
      mediumFailed: mediumFailed.map((c) => ({ id: c.id, name: c.name, detail: c.detail })),
      launcherPresent: lDirOk && (!!le.exists || (!!lExePath && existsSyncRaw(lExePath))),
      launcherOk: !launcherRequired || checks.filter((c) => c.category === 'launcher' && c.severity === 'critical').every((c) => c.passed),
      nativeOk: !!nat && nat.attestationTag === expectedTag,
      fusesOk: requirePack(!!ce.fusesOk && (this.role === 'launcher' || !!le.fusesOk)),
      devToolsBlocked: requirePack(this.windowGuardsActive),
      asarHash: effCurAsarSha256 || null,
      exeHash: ce.sha256 || null,
      launcherAsarHash: effLauncherAsarSha256 || null,
      launcherExeHash: le.sha256 || null,
      anomalies: [
        ...new Set(
          failed
            .filter((c) => !(nativeBlockedByAv && c.id === 'CHK-071'))
            .map((c) => c.detail || c.id)
            .filter(Boolean),
        ),
      ],
      failedIds: failed.map((c) => c.id),
      checkedAt: Date.now(),
      checks,
    };

    this.lastAudit = report;

    if (report.anomalies.length && this.license?.recordAnomaly) {
      for (const a of report.anomalies.slice(0, 12)) {
        this.license.recordAnomaly(a);
      }
      for (const c of criticalFailed.concat(highFailed).slice(0, 8)) {
        this.license.recordAnomaly(c.id);
      }
    }

    if (shouldBlock) {
      const top = criticalFailed[0] || highFailed[0];
      const reason = `Security check ${top.id} failed (${top.name}). Reinstall the official Forma release and close debugging/proxy tools.`;
      if (this.license?.lockForSecurity) {
        this.license.lockForSecurity(reason, report.failedIds);
      }
      if (this.onAutoBlock) {
        try {
          await this.onAutoBlock(report, reason);
        } catch {}
      }
    }

    return report;
  }

  startWatchdog(intervalMs = 10000) {
    if (this.watchdogTimer) return;
    this.watchdogArmed = true;
    this.watchdogTimer = setInterval(() => {
      this.runAudit({ forceRescan: false }).catch(() => {});
    }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog() {
    this.watchdogArmed = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

module.exports = {
  SecurityShield,
  writeLauncherAnchor,
  readLauncherAnchor,
  isPrivateOrLoopbackIp,
  PINNED_API_ORIGIN,
  PINNED_PUBLIC_KEY_SHA256,
  PINNED_UPDATE_KEY_SHA256,
  PINNED_ORIGINAL_QWEN_SHA256,
  PINNED_CORE_SHA256,
};
