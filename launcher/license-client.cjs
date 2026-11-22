'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const DOMAIN = 'FORMA-LEASE-v1\n';

function defaultSystemTelemetry() {
  try {
    const host = os.hostname() || '';
    const hostnameHash = host ? crypto.createHash('sha256').update(host).digest('hex') : null;
    const osUser = (() => { try { return String(os.userInfo()?.username || '').slice(0, 64) || null; } catch { return null; } })();
    const cpuModel = (() => { try { return String(os.cpus?.()?.[0]?.model || '').slice(0, 80) || null; } catch { return null; } })();
    return {
      platform: process.platform,
      osRelease: typeof os.release === 'function' ? os.release() : null,
      arch: process.arch,
      computerName: host ? String(host).slice(0, 64) : null,
      osUser,
      cpuModel,
      cpuCount: Array.isArray(os.cpus?.()) ? os.cpus().length : null,
      ramGb: typeof os.totalmem === 'function' ? Math.round((os.totalmem() / 1073741824) * 10) / 10 : null,
      hostnameHash,
    };
  } catch {
    return {};
  }
}

function verifiedReceipt(envelope, { publicKey, device, nonce, now = Date.now() }) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 8000 || typeof envelope.signature !== 'string') {
    throw Error('Invalid server response.');
  }
  if (!crypto.verify(null, Buffer.from(DOMAIN + envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64url'))) {
    throw Error('The access response signature is invalid.');
  }
  const p = JSON.parse(envelope.payload);
  if (p.v !== 1 || p.aud !== 'forma' || p.device !== device || p.nonce !== nonce || !['active', 'invalid'].includes(p.status)) {
    throw Error('The access response does not match this request.');
  }
  if (!Number.isSafeInteger(p.issuedAt) || Math.abs(now - p.issuedAt) > 60000) {
    throw Error('The system clock does not match the server time.');
  }
  if (
    p.status === 'active' &&
    (!Number.isSafeInteger(p.validUntil) ||
      !Number.isSafeInteger(p.licenseExpiresAt) ||
      p.validUntil <= now ||
      p.validUntil > p.issuedAt + 120000 ||
      p.validUntil > p.licenseExpiresAt)
  ) {
    throw Error('Access has expired.');
  }
  return p;
}

function unwrapSeal(seal, device, nonce, expectedId) {
  try {
    if (!seal || typeof seal.wrapped !== 'string' || !expectedId || seal.id !== expectedId) return null;
    const raw = Buffer.from(seal.wrapped, 'base64url');
    if (raw.length !== 12 + 16 + 32) return null;
    const wrapKey = crypto.createHash('sha256').update('FORMA-SEAL-WRAP-v1|' + device + '|' + nonce).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', wrapKey, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  } catch {
    return null;
  }
}

class LicenseClient extends EventEmitter {
  #lease = null;
  #securityLock = null;
  #seal = null;
  sealId = '';
  constructor({ root, safeStorage, config, fetchImpl = globalThis.fetch, now = Date.now, mono = () => performance.now(), getTelemetry = null }) {
    super();
    this.root = root;
    this.safeStorage = safeStorage;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.mono = mono;
    this.getTelemetry = getTelemetry;
    this.value = { status: 'checking', message: 'Checking access…', expiresAt: 0, accessType: 'standard', policy: null };
    this.key = '';
    this.device = '';
    this.pending = null;
    this.stopped = false;
    this.activationQueue = Promise.resolve();
    this.activating = false;
    this.pendingAnomalies = new Set();
    this.ackedMessageIds = new Set();
    this.handledCmdIds = new Set();
    this.lastHeartbeatAt = 0;
    this.consecutiveHeartbeatFailures = 0;
    this.lastHeartbeatBlocked = false;
    this._lastTelemetryExtra = { appVersion: config?.appVersion || null };
  }

  recordAnomaly(name) {
    if (typeof name === 'string' && name.trim()) this.pendingAnomalies.add(name.trim().slice(0, 64));
  }

  lockForSecurity(reason, failedIds = []) {
    const cleanReason = String(reason || 'Security integrity check failed. Reinstall official Forma.').slice(0, 400);
    const ids = Array.isArray(failedIds) ? failedIds.map((x) => String(x).slice(0, 32)) : [];
    for (const id of ids) this.recordAnomaly(id);
    this.#lease = null;
    this.#seal = null;
    this.#securityLock = Object.freeze({ reason: cleanReason, failedIds: Object.freeze(ids), lockedAt: this.now() });
    this.value = { ...this.value, status: 'security-blocked', message: cleanReason, expiresAt: 0 };
    const snap = this.snapshot();
    this.emit('security-block', snap);
    this.emit('change', snap);
    return snap;
  }

  clearSecurityLock() {
    this.#securityLock = null;
    this.lastHeartbeatBlocked = false;
    this.consecutiveHeartbeatFailures = 0;
    for (const stale of ['SERVER_REVIEW', 'CHK-097', 'backend_integrity_block', 'asar_hash_missing', 'exe_hash_missing', 'launcher_hash_missing']) {
      this.pendingAnomalies.delete(stale);
    }
  }

  snapshot() {
    if (this.#securityLock) {
      return {
        ...this.value,
        status: 'security-blocked',
        message: this.#securityLock.reason,
        expiresAt: 0,
        permanent: false,
        accessType: this.value.accessType || 'standard',
        policy: this.value.policy || null,
        remainingMs: 0,
        securityLock: this.#securityLock,
        device: this.device,
        gatewayReady: !!this.config.gatewayUrl,
      };
    }
    let status = this.value.status;
    const lease = this.#lease,
      mono = this.mono(),
      now = this.now();
    if (
      status === 'active' &&
      (!lease || !Number.isFinite(mono) || !Number.isFinite(now) || mono < lease.monoStart || mono >= lease.deadline || now >= lease.expiresAt || now < lease.wallStart - 5000)
    ) {
      status = 'expired';
    }
    const rawPolicy = status === 'active' ? lease.policy : this.value.policy || null;
    const policy =
      rawPolicy && rawPolicy.directMessage && this.ackedMessageIds.has(rawPolicy.directMessage.id)
        ? { ...rawPolicy, directMessage: null }
        : rawPolicy;
    return {
      ...this.value,
      status,
      expiresAt: status === 'active' ? lease.expiresAt : this.value.expiresAt,
      permanent: status === 'active' && lease.permanent === true,
      accessType: status === 'active' ? lease.accessType : this.value.accessType || 'standard',
      policy,
      remainingMs: status === 'active' ? Math.max(0, Math.min(lease.expiresAt - now, lease.remaining - (mono - lease.monoStart))) : 0,
      device: this.device,
      gatewayReady: !!this.config.gatewayUrl,
    };
  }

  set(value) {
    if (value.status && value.status !== 'active') {
      this.#lease = null;
      this.#seal = null;
    }
    this.value = { ...this.value, ...value };
    if (!(this.activating && value.status === 'active')) this.emit('change', this.snapshot());
    return this.snapshot();
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, 'installation-id');
    try {
      await fs.writeFile(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    this.device = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(this.device)) throw Error('The installation identifier is invalid.');
    try {
      const data = await fs.readFile(path.join(this.root, 'license.dpapi'));
      if (!this.safeStorage.isEncryptionAvailable()) throw Error('Encrypted storage is unavailable.');
      this.key = await this.safeStorage.decryptString(data);
    } catch (e) {
      if (e.code !== 'ENOENT') this.set({ status: 'invalid', message: 'The saved key could not be decrypted. Enter it again.' });
    }
    await this.check();
    this.timer = setInterval(async () => {
      try {
        const st = await fs.stat(path.join(this.root, 'license.dpapi')).catch(() => null);
        const stamp = st ? st.mtimeMs + ':' + st.size : '';
        if (stamp !== this.storedStamp || this.now() - (this.value.lastCheckedAt || 0) >= 30000) await this.check();
        else if (this.value.status === 'active' && this.now() - this.lastHeartbeatAt >= 10000) await this.heartbeat();
      } catch {}
    }, 1500);
    this.timer.unref?.();
    this.expiryTimer = setInterval(() => {
      const s = this.snapshot();
      if (s.status !== this.value.status) this.set({ status: s.status, message: 'Access expired or an online verification is required.' });
    }, 1000);
    this.expiryTimer.unref?.();
    if (this.value.status === 'active') this.heartbeat().catch(() => {});
    return this.snapshot();
  }

  activate(key) {
    const run = async () => {
      this.activating = true;
      try {
        return await this._activate(key);
      } finally {
        this.activating = false;
      }
    };
    const next = this.activationQueue.then(run, run);
    this.activationQueue = next.catch(() => {});
    return next;
  }

  async _activate(key) {
    if (typeof key !== 'string' || key.trim().length < 12 || key.length > 4096) throw Error('Enter a complete Forma access key.');
    if (!this.safeStorage.isEncryptionAvailable()) throw Error('Encrypted storage is unavailable. The key will not be saved unencrypted.');
    if (this.pending) {
      await Promise.race([
        this.pending.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    }
    const previous = this.key;
    this.clearSecurityLock();
    this.lastHeartbeatAt = 0;
    this.key = key.trim();
    this.set({ status: 'checking', message: 'Verifying your key…', expiresAt: 0 });
    const result = await this._runCheck(true, { fast: true });
    if (result.status !== 'active') {
      this.key = previous;
      return result;
    }
    const tmp = path.join(this.root, 'license.' + crypto.randomUUID() + '.tmp');
    const dest = path.join(this.root, 'license.dpapi');
    try {
      await fs.writeFile(tmp, await this.safeStorage.encryptString(this.key), { mode: 0o600 });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await fs.rename(tmp, dest);
          break;
        } catch (err) {
          if (attempt === 2 || (err?.code !== 'EPERM' && err?.code !== 'EBUSY')) throw err;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
      const st = await fs.stat(dest);
      this.storedStamp = st.mtimeMs + ':' + st.size;
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      this.key = previous;
      this.set({ status: 'storage-error', message: 'The key could not be stored securely.' });
      throw e;
    }
    const activeSnap = this.snapshot();
    this.emit('change', activeSnap);
    this.heartbeat().catch(() => {});
    return activeSnap;
  }

  async _collectMergedTelemetry(opts = {}) {
    const base = defaultSystemTelemetry();
    let extra = this._lastTelemetryExtra || { appVersion: this.config?.appVersion || null };
    if (typeof this.getTelemetry === 'function') {
      try {
        const timeoutMs = opts.fast ? 2500 : 3500;
        const fresh = await Promise.race([
          Promise.resolve().then(() => this.getTelemetry(opts)),
          new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (fresh && typeof fresh === 'object') {
          extra = { ...extra, ...fresh };
          this._lastTelemetryExtra = extra;
        }
      } catch {}
    }
    const merged = { ...base, ...extra };
    if (this.pendingAnomalies.size) {
      const cleaned = [...this.pendingAnomalies].filter((a) => a !== 'SERVER_REVIEW' && a !== 'CHK-097');
      if (cleaned.length || merged.anomalies?.length) {
        merged.anomalies = [...new Set([...(merged.anomalies || []), ...cleaned])];
      }
    }
    return merged;
  }

  async check(skipDisk = false, opts = {}) {
    if (this.stopped) return this.snapshot();
    if (this.pending) return this.pending;
    if (this.activating && !skipDisk) return this.snapshot();
    return this._runCheck(skipDisk, opts);
  }

  async _runCheck(skipDisk = false, opts = {}) {
    const work = this._check(skipDisk, opts);
    this.pending = work;
    try {
      return await work;
    } finally {
      if (this.pending === work) this.pending = null;
    }
  }

  async _check(skipDisk, opts = {}) {
    if (!skipDisk) {
      try {
        const file = path.join(this.root, 'license.dpapi'),
          st = await fs.stat(file),
          stamp = st.mtimeMs + ':' + st.size;
        if (stamp !== this.storedStamp) {
          if (!this.safeStorage.isEncryptionAvailable()) throw Error('Encrypted storage is locked.');
          this.key = await this.safeStorage.decryptString(await fs.readFile(file));
          this.storedStamp = stamp;
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          if (this.storedStamp) this.key = '';
          this.storedStamp = '';
        } else return this.set({ status: 'invalid', message: 'The saved key could not be checked.' });
      }
    }
    if (!this.key) return this.set({ status: 'missing', message: 'Enter your access key to unlock Forma and Qwen.', expiresAt: 0 });
    let url;
    try {
      url = new URL(this.config.apiUrl);
      if (url.protocol !== 'https:') throw Error();
      crypto.createPublicKey(this.config.publicKey);
    } catch {
      return this.set({ status: 'setup', message: 'The access service is not configured.' });
    }
    const nonce = crypto.randomBytes(32).toString('hex');
    const telemetry = await this._collectMergedTelemetry(opts);
    try {
      const payload = { key: this.key, device: this.device, nonce, telemetry, ...(this.sealId ? { sealId: this.sealId } : {}) };
      const r = await this.fetch(new URL('/v1/validate', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw Error('The access service returned HTTP ' + r.status + '.');
      const raw = await r.text();
      if (raw.length > 12000) throw Error('The access response is too large.');
      const p = verifiedReceipt(JSON.parse(raw), { publicKey: this.config.publicKey, device: this.device, nonce, now: this.now() });
      const policy = p.policy && typeof p.policy === 'object' ? Object.freeze({ ...p.policy }) : null;
      const realLocalCrit = (telemetry?.shield?.criticalFailed || []).filter((id) => id !== 'CHK-097');
      if (telemetry?.shield?.blocked && !(p.status === 'active' && realLocalCrit.length === 0)) {
        const failed = (realLocalCrit.length ? realLocalCrit : (telemetry.shield.criticalFailed || telemetry.shield.highFailed || []))[0];
        return this.lockForSecurity(
          failed && typeof failed === 'object'
            ? `Security check ${failed.id} failed (${failed.name}). Reinstall official Forma.`
            : typeof failed === 'string'
              ? `Security check ${failed} failed. Reinstall official Forma.`
              : 'Local security integrity check failed.',
          telemetry.shield.failedIds || [],
        );
      }
      if (p.status !== 'active') {
        if (policy?.integrityReview) {
          return this.lockForSecurity(
            p.message || policy.integrityReviewMessage || 'Access is locked for an integrity review. Your files are safe. Use the appeal option to contact Forma support.',
            ['SERVER_REVIEW'],
          );
        }
        let nextStatus = 'invalid';
        if (policy?.banned) nextStatus = 'banned';
        else if (policy?.maintenanceMode) nextStatus = 'maintenance';
        else if (policy?.forceUpdate && /Update required/i.test(p.message || '')) nextStatus = 'update-required';
        return this.set({ status: nextStatus, message: p.message || 'The key is invalid or expired.', expiresAt: 0, policy });
      }
      this.clearSecurityLock();
      this.#seal = unwrapSeal(p.seal, this.device, nonce, this.sealId);
      this.consecutiveHeartbeatFailures = 0;
      this.monoStart = this.mono();
      this.wallStart = this.now();
      this.deadline = this.monoStart + p.validUntil - this.wallStart;
      this.licenseRemaining = p.licenseExpiresAt - this.wallStart;
      this.#lease = Object.freeze({
        monoStart: this.monoStart,
        wallStart: this.wallStart,
        deadline: this.deadline,
        expiresAt: p.licenseExpiresAt,
        permanent: p.accessType === 'admin',
        accessType: p.accessType || 'standard',
        remaining: this.licenseRemaining,
        policy,
      });
      return this.set({
        status: 'active',
        message: 'Access active',
        expiresAt: p.licenseExpiresAt,
        lastCheckedAt: this.wallStart,
        licenseId: p.licenseId,
        accessType: p.accessType || 'standard',
        policy,
      });
    } catch (e) {
      const active = this.snapshot().status === 'active';
      return this.set({
        status: active ? 'active' : 'offline',
        message: active ? 'Connection interrupted. Verification will retry automatically.' : 'Access could not be verified. Check your internet connection.',
        lastError: e.message,
      });
    }
  }

  async ackMessage(messageId) {
    if (!messageId || !this.device || !this.config.apiUrl) return false;
    this.ackedMessageIds.add(String(messageId));
    this.emit('change', this.snapshot());
    try {
      const u = new URL('/v1/message/ack', this.config.apiUrl);
      if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      await this.fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device: this.device, messageId: String(messageId) }),
        signal: AbortSignal.timeout(8000),
      });
      return true;
    } catch {
      return false;
    }
  }

  async ackCommand(cmdId, ok = true, detail = '') {
    if (!cmdId || !this.device || !this.config.apiUrl) return false;
    try {
      const u = new URL('/v1/command/ack', this.config.apiUrl);
      if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      await this.fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device: this.device,
          cmdId: String(cmdId),
          ok: ok !== false,
          detail: String(detail || '').slice(0, 400),
        }),
        signal: AbortSignal.timeout(8000),
      });
      return true;
    } catch {
      return false;
    }
  }

  async heartbeat() {
    if (this.stopped || !this.device || !this.config.apiUrl || this.value.status !== 'active') return null;
    this.lastHeartbeatAt = this.now();
    let u;
    try {
      u = new URL('/v1/heartbeat', this.config.apiUrl);
      if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
    } catch {
      return null;
    }
    try {
      const telemetry = await this._collectMergedTelemetry();
      const nonce = crypto.randomBytes(32).toString('hex');
      const r = await this.fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device: this.device, nonce, telemetry }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        this.consecutiveHeartbeatFailures += 1;
        if (this.consecutiveHeartbeatFailures >= 3) {
          this.#lease = null;
          this.set({ status: 'offline', message: 'Verification heartbeat failed repeatedly. Reconnecting…', expiresAt: 0 });
        }
        return null;
      }
      const raw = await r.text();
      if (raw.length > 64000) return this.lockForSecurity('The signed security response was too large.', ['heartbeat_response_size']);
      const envelope = JSON.parse(raw);
      if (typeof envelope?.payload !== 'string' || envelope.payload.length > 56000 || typeof envelope.signature !== 'string') {
        return this.lockForSecurity('Forma could not verify the server security response.', ['heartbeat_signature_missing']);
      }
      if (!crypto.verify(null, Buffer.from('FORMA-HEARTBEAT-v1\n' + envelope.payload), this.config.publicKey, Buffer.from(envelope.signature, 'base64url'))) {
        this.recordAnomaly('heartbeat_sig_invalid');
        return this.lockForSecurity('Forma could not verify the server security response.', ['heartbeat_sig_invalid']);
      }
      const data = JSON.parse(envelope.payload);
      const legacySignedHeartbeat = data.v === undefined && data.aud === undefined && data.issuedAt === undefined;
      const heartbeatTimeValid = legacySignedHeartbeat || (data.v === 1 && data.aud === 'forma' && Number.isSafeInteger(data.issuedAt) && Math.abs(this.now() - data.issuedAt) <= 60000);
      if (
        !heartbeatTimeValid ||
        data.ok !== true ||
        data.device !== this.device ||
        data.nonce !== nonce
      ) {
        this.recordAnomaly('heartbeat_response_mismatch');
        return this.lockForSecurity('Forma could not verify this server security response.', ['heartbeat_response_mismatch']);
      }
      this.consecutiveHeartbeatFailures = 0;
      if (data.banned) {
        return this.set({ status: 'banned', message: data.banReason || 'This installation has been blocked by the Forma administrator.', expiresAt: 0 });
      }
      if (data.integrityLocked || data.status === 'flagged') {
        return this.lockForSecurity(
          data.integrityLockMessage || 'Access is locked for an integrity review. Your files are safe. Use the appeal option to contact Forma support.',
          ['SERVER_REVIEW'],
        );
      }
      if (data.integrity?.blocked) {
        this.lastHeartbeatBlocked = true;
        return this.lockForSecurity(data.integrity.reason || 'Security integrity check failed.', ['CHK-097']);
      }
      const nextPolicy = { ...(this.#lease?.policy || this.value.policy || {}) };
      let policyChanged = false;
      for (const k of ['bannerMessage', 'bannerLevel', 'forcedMode', 'latestRelease', 'allowedModes', 'disabledTools']) {
        if (data[k] !== undefined && JSON.stringify(nextPolicy[k]) !== JSON.stringify(data[k])) {
          nextPolicy[k] = data[k];
          policyChanged = true;
        }
      }
      if (data.directMessage && !this.ackedMessageIds.has(data.directMessage.id)) {
        if (nextPolicy.directMessage?.id !== data.directMessage.id) {
          nextPolicy.directMessage = data.directMessage;
          policyChanged = true;
        }
      }
      if (policyChanged) {
        const frozen = Object.freeze(nextPolicy);
        if (this.#lease) {
          this.#lease = Object.freeze({ ...this.#lease, policy: frozen });
        }
        this.value = { ...this.value, policy: frozen };
        this.emit('change', this.snapshot());
      }
      if (Array.isArray(data.pendingCommands) && data.pendingCommands.length) {
        const fresh = data.pendingCommands.filter((c) => c && c.cmdId && !this.handledCmdIds.has(c.cmdId));
        if (fresh.length) {
          for (const c of fresh) {
            this.handledCmdIds.add(c.cmdId);
            if (this.handledCmdIds.size > 300) this.handledCmdIds.delete(this.handledCmdIds.values().next().value);
          }
          this.emit('commands', fresh);
        }
      }
      return data;
    } catch {
      this.consecutiveHeartbeatFailures += 1;
      if (this.consecutiveHeartbeatFailures >= 3) {
        this.#lease = null;
        this.set({ status: 'offline', message: 'Verification heartbeat lost. Reconnecting…', expiresAt: 0 });
      }
      return null;
    }
  }

  assertModeAllowed(mode) {
    const allowed = this.snapshot().policy?.allowedModes;
    if (Array.isArray(allowed) && !allowed.includes(mode)) throw Error(`The "${mode}" execution mode is temporarily disabled by the Forma administrator.`);
  }

  getEnabledFeatures() {
    const s = this.snapshot();
    if (s.status !== 'active') return [];
    const list = s.policy?.enabledFeatures;
    if (Array.isArray(list)) return [...list];
    return ['tools', 'limit-reset', 'integrations', 'accounts', 'bug-report'];
  }

  isFeatureEnabled(feature) {
    const s = this.snapshot();
    if (s.status !== 'active') return false;
    const list = s.policy?.enabledFeatures;
    if (!Array.isArray(list)) return true;
    return list.includes(feature);
  }

  assertFeatureEnabled(feature, label = feature) {
    this.requireActive();
    if (!this.isFeatureEnabled(feature)) {
      throw Error(`The "${label}" feature is disabled on your account by the Forma server.`);
    }
  }

  async keyUrl() {
    if (!this.config.gatewayUrl) throw Error('The key page is not configured.');
    const u = new URL(this.config.gatewayUrl);
    u.searchParams.set('device', this.device);
    return u.href;
  }

  async submitBugReport({ title = '', description = '', category = 'bug', screenshotDataUrl = null, activity = null } = {}) {
    const cleanDesc = String(description || '').trim();
    if (cleanDesc.length < 4) throw Error('Please describe what happened.');
    if (!this.key || !this.device) throw Error('Activate a license key before sending a bug report.');
    let url;
    try {
      url = new URL('/v1/bug-report', this.config.apiUrl);
      if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw Error();
    } catch {
      throw Error('The feedback service is not configured.');
    }
    const telemetry = await this._collectMergedTelemetry();
    const body = {
      key: this.key,
      device: this.device,
      title: String(title || '').trim().slice(0, 120),
      description: cleanDesc.slice(0, 3000),
      category: String(category || 'bug').trim().slice(0, 32),
      screenshotDataUrl: typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image/') ? screenshotDataUrl : null,
      telemetry,
      activity: activity || telemetry?.activity || null,
    };
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) throw Error(data?.error || ('Could not send bug report (HTTP ' + r.status + ').'));
    return data;
  }

  setSealId(id) {
    this.sealId = /^[a-f0-9]{16}$/.test(String(id)) ? String(id) : '';
  }

  getSealKey() {
    if (!this.#seal || this.snapshot().status !== 'active') return null;
    return Buffer.from(this.#seal);
  }

  requireActive() {
    const s = this.snapshot();
    if (s.status !== 'active') throw Error(s.message || 'An active license key is required.');
    return s;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.expiryTimer);
  }
}

module.exports = { LicenseClient, verifiedReceipt, unwrapSeal };
