'use strict';
/**
 * Forma Claude — signed updater.
 *
 * The only trusted input is an Ed25519-signed release envelope. A downloaded
 * installer that is not signed by the Forma release key is deleted, not run.
 *
 * Flow
 *   1. GET  /v1/releases/latest          -> { payload, signature }
 *   2. verify signature over             FORMA-CLAUDE-RELEASE-v1\n<payload>
 *   3. compare semver, skip if not newer
 *   4. download to temp, stream to disk, hash while writing
 *   5. verify SHA-256 and size
 *   6. back up resources/app.asar        -> app.asar.bak
 *   7. write pending.json, run installer /S, quit
 *
 * Boot guard (call `guardBoot()` early in the main process)
 *   - three consecutive failed boots on a new version restores app.asar.bak
 *     and clears the marker, so a bad release cannot brick the install.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const RELEASE_DOMAIN = 'FORMA-CLAUDE-RELEASE-v1';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const MAX_BOOT_FAILURES = 3;

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** -1 if a < b, 0 equal, 1 if a > b. */
function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function verifyRelease(envelope, publicKey) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 64_000) {
    throw new Error('release envelope is malformed');
  }
  if (typeof envelope?.signature !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/.test(envelope.signature)) {
    throw new Error('release signature is malformed');
  }
  const ok = crypto.verify(
    null,
    Buffer.from(`${RELEASE_DOMAIN}\n${envelope.payload}`, 'utf8'),
    publicKey,
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!ok) throw new Error('release signature is invalid');
  const payload = JSON.parse(envelope.payload);
  if (payload.v !== 1) throw new Error(`unsupported release schema ${payload.v}`);
  if (!parseSemver(payload.version)) throw new Error('release version is invalid');
  if (!Array.isArray(payload.assets) || !payload.assets.length) throw new Error('release has no assets');
  return payload;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

class FormaUpdater {
  /**
   * @param {object} opts
   * @param {string} opts.apiUrl      license server origin
   * @param {string} opts.currentVersion
   * @param {string} opts.publicKeyPem
   * @param {string} opts.userData    app.getPath('userData')
   * @param {string} opts.appRoot     dir containing resources/app.asar
   * @param {Function} [opts.onStatus]
   */
  constructor(opts) {
    this.apiUrl = String(opts.apiUrl || '').replace(/\/+$/, '');
    this.currentVersion = opts.currentVersion || '0.0.0';
    this.publicKey = crypto.createPublicKey(opts.publicKeyPem);
    this.userData = opts.userData;
    this.appRoot = opts.appRoot;
    this.onStatus = opts.onStatus || (() => {});
    this.timer = null;
    this.busy = false;
    this.stopped = false;
    this.state = { phase: 'idle', version: this.currentVersion, progress: 0, error: null };
  }

  get dir() {
    return path.join(this.userData, 'updates');
  }

  get pendingFile() {
    return path.join(this.dir, 'pending.json');
  }

  get markerFile() {
    return path.join(this.dir, 'boot.json');
  }

  get asarFile() {
    return path.join(this.appRoot, 'resources', 'app.asar');
  }

  get asarBackup() {
    return path.join(this.appRoot, 'resources', 'app.asar.bak');
  }

  status(patch) {
    this.state = { ...this.state, ...patch };
    try {
      this.onStatus(this.state);
    } catch {}
    return this.state;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    return this;
  }

  async fetchLatest() {
    const res = await fetch(`${this.apiUrl}/v1/releases/latest`, {
      headers: { 'user-agent': `FormaClaude/${this.currentVersion}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`release feed returned HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.envelope) throw new Error('release feed has no envelope');
    return verifyRelease(json.envelope, this.publicKey);
  }

  assetFor(payload) {
    const platform = process.platform === 'win32' ? 'win32' : process.platform;
    const arch = process.arch === 'x64' ? 'x64' : process.arch;
    return (
      payload.assets.find((a) => a.platform === platform && a.arch === arch) ||
      payload.assets.find((a) => a.platform === platform) ||
      null
    );
  }

  /** Download with a hard byte ceiling, hashing while writing. */
  async download(asset, target) {
    const res = await fetch(asset.url, {
      headers: { 'user-agent': `FormaClaude/${this.currentVersion}` },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
    if (!res.body) throw new Error('download produced no body');

    const total = Number(asset.size || res.headers.get('content-length') || 0);
    if (total > MAX_INSTALLER_BYTES) throw new Error('installer is larger than the allowed size');

    await fsp.mkdir(path.dirname(target), { recursive: true });
    const handle = await fsp.open(target, 'w');
    const hash = crypto.createHash('sha256');
    let written = 0;
    try {
      for await (const chunk of res.body) {
        written += chunk.length;
        if (written > MAX_INSTALLER_BYTES) throw new Error('installer exceeded the allowed size');
        hash.update(chunk);
        await handle.write(chunk);
        if (total) {
          this.status({ phase: 'downloading', progress: Math.min(1, written / total), bytes: written, total });
        }
      }
    } finally {
      await handle.close();
    }

    const digest = hash.digest('hex');
    if (String(asset.sha256 || '').toLowerCase() !== digest) {
      await fsp.rm(target, { force: true });
      throw new Error('installer checksum does not match the signed release');
    }
    if (asset.size && Number(asset.size) !== written) {
      await fsp.rm(target, { force: true });
      throw new Error('installer size does not match the signed release');
    }
    return { file: target, bytes: written, sha256: digest };
  }

  /** Snapshot the current bundle so a failed boot can be rolled back. */
  async backupBundle() {
    try {
      const stat = await fsp.stat(this.asarFile);
      if (!stat.isFile()) return false;
      await fsp.copyFile(this.asarFile, this.asarBackup);
      return true;
    } catch {
      return false;
    }
  }

  async check({ install = true } = {}) {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    try {
      this.status({ phase: 'checking', progress: 0, error: null });
      const payload = await this.fetchLatest();
      if (!payload) {
        this.status({ phase: 'idle', progress: 0 });
        return { ok: true, update: null };
      }
      if (compareSemver(payload.version, this.currentVersion) <= 0) {
        this.status({ phase: 'idle', progress: 0, latest: payload.version });
        return { ok: true, update: null, latest: payload.version };
      }

      const asset = this.assetFor(payload);
      if (!asset) {
        this.status({ phase: 'idle', progress: 0, error: 'no asset for this platform' });
        return { ok: false, reason: 'no-asset', version: payload.version };
      }

      this.status({ phase: 'available', version: payload.version, progress: 0, notes: payload.notes || '' });
      if (!install) return { ok: true, update: payload, asset };

      const target = path.join(this.dir, `FormaClaude-${payload.version}${path.extname(new URL(asset.url).pathname) || '.exe'}`);
      const file = await this.download(asset, target);

      await this.backupBundle();
      await fsp.writeFile(
        this.pendingFile,
        JSON.stringify({ version: payload.version, sha256: file.sha256, at: Date.now() }),
        'utf8',
      );

      this.status({ phase: 'ready', version: payload.version, progress: 1 });
      return { ok: true, update: payload, file: file.file, download: file };
    } catch (err) {
      const message = String(err?.message || err);
      this.status({ phase: 'error', progress: 0, error: message });
      return { ok: false, reason: message };
    } finally {
      this.busy = false;
    }
  }

  /** Run the verified installer silently. Caller quits the app afterwards. */
  async apply(file) {
    if (!file || !fs.existsSync(file)) throw new Error('installer is missing');
    const pending = JSON.parse(await fsp.readFile(this.pendingFile, 'utf8').catch(() => '{}'));
    const digest = await sha256File(file);
    if (pending.sha256 && pending.sha256 !== digest) throw new Error('installer changed after verification');

    this.status({ phase: 'installing', progress: 1 });
    return new Promise((resolve, reject) => {
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  }

  start() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.check({ install: true }).catch(() => {});
    }, CHECK_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // First pass shortly after boot, never during the first paint.
    setTimeout(() => this.check({ install: true }).catch(() => {}), 20_000).unref?.();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Boot guard. Call before creating windows.
   * A version that fails to reach `confirmHealthy()` three times is rolled back.
   */
  async guardBoot() {
    await fsp.mkdir(this.dir, { recursive: true });
    let marker = null;
    try {
      marker = JSON.parse(await fsp.readFile(this.markerFile, 'utf8'));
    } catch {}

    if (!marker || marker.version !== this.currentVersion) {
      marker = { version: this.currentVersion, attempts: 0, healthy: false };
    }
    marker.attempts += 1;

    if (marker.attempts > MAX_BOOT_FAILURES && fs.existsSync(this.asarBackup)) {
      try {
        await fsp.copyFile(this.asarBackup, this.asarFile);
        await fsp.writeFile(
          this.markerFile,
          JSON.stringify({ version: this.currentVersion, attempts: 0, healthy: false, rolledBackAt: Date.now() }),
          'utf8',
        );
        return { rolledBack: true };
      } catch {
        /* fall through: a failed restore must not block the app */
      }
    }

    await fsp.writeFile(this.markerFile, JSON.stringify(marker), 'utf8');
    return { rolledBack: false, attempts: marker.attempts };
  }

  /** Call once the app has been interactive for a few seconds. */
  async confirmHealthy() {
    try {
      await fsp.writeFile(
        this.markerFile,
        JSON.stringify({ version: this.currentVersion, attempts: 0, healthy: true, at: Date.now() }),
        'utf8',
      );
      await fsp.rm(this.pendingFile, { force: true });
    } catch {}
  }
}

module.exports = { FormaUpdater, verifyRelease, compareSemver, parseSemver, RELEASE_DOMAIN, MAX_BOOT_FAILURES };
