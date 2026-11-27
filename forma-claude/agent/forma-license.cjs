'use strict';
/**
 * Forma Claude — license client (main process).
 *
 * The server is the only source of truth. Nothing is trusted locally:
 *   - the key is stored with safeStorage (DPAPI) only
 *   - every access decision comes from a signed envelope
 *   - the envelope echoes a fresh nonce, so a replay is useless
 *   - the lease is short (15 min) and renewed at 45 s
 *
 * States: checking | active | invalid | expired | offline | security-blocked
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');

const LEASE_DOMAIN = 'FORMA-CLAUDE-LEASE-v1';
const KEY_PREFIX = 'FORMA1';
const AUDIENCE = 'forma-claude';

const RENEW_MS = 45_000;
const RETRY_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;
const OFFLINE_GRACE_MS = 90_000;
const MAX_CLOCK_SKEW_MS = 90_000;

const DEFAULT_API = 'https://forma-claude-production.up.railway.app';

function nowMs() {
  return Date.now();
}

function maskKey(key) {
  const raw = String(key || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return '';
  return `${parts[0]}.${parts[1].slice(0, 6)}…${parts[2].slice(-6)}`;
}

function formatShortDevice(deviceId) {
  const clean = String(deviceId || '').trim();
  if (/^[a-f0-9]{16,}$/i.test(clean)) {
    return `FRM-${clean.slice(0, 4).toUpperCase()}-${clean.slice(4, 8).toUpperCase()}`;
  }
  return clean ? clean.slice(0, 16) : '';
}

/**
 * Verify a signed envelope. Throws with a human message on any mismatch.
 * Exported so the test harness can prove it rejects tampering.
 */
function verifyEnvelope(envelope, { publicKey, device, nonce, now = nowMs() }) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 16_000) {
    throw new Error('Invalid server response.');
  }
  if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{40,120}$/.test(envelope.signature)) {
    throw new Error('Invalid server response.');
  }
  if (!publicKey) throw new Error('The access verifier is unavailable.');

  const ok = crypto.verify(
    null,
    Buffer.from(`${LEASE_DOMAIN}\n${envelope.payload}`, 'utf8'),
    publicKey,
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!ok) throw new Error('The access response signature is invalid.');

  let payload;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    throw new Error('Invalid server response.');
  }

  if (payload.v !== 1 || payload.aud !== AUDIENCE) throw new Error('The access response is not for this app.');
  if (payload.device !== device) throw new Error('The access response does not match this device.');
  if (payload.nonce !== nonce) throw new Error('The access response does not match this request.');
  if (!['active', 'invalid'].includes(payload.status)) throw new Error('The access response is not recognised.');
  if (!Number.isSafeInteger(payload.issuedAt) || Math.abs(now - payload.issuedAt) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Your system clock does not match Forma servers. Sync the clock and try again.');
  }
  if (payload.status === 'active') {
    if (
      !Number.isSafeInteger(payload.validUntil) ||
      !Number.isSafeInteger(payload.licenseExpiresAt) ||
      payload.validUntil <= now ||
      payload.validUntil > payload.issuedAt + 20 * 60_000 ||
      payload.validUntil > payload.licenseExpiresAt
    ) {
      throw new Error('Access has expired. Get a new key to continue.');
    }
  }
  return payload;
}

class FormaLicense extends EventEmitter {
  constructor({ appData, safeStorage, apiUrl = DEFAULT_API, appVersion = '0.0.0' }) {
    super();
    this.root = path.join(appData, 'FormaClaude');
    this.safeStorage = safeStorage;
    this.apiUrl = String(apiUrl || DEFAULT_API).replace(/\/+$/, '');
    this.appVersion = appVersion;
    this.publicKey = null;

    this.device = '';
    this.key = '';
    this.lease = null;
    this.lastServerAt = 0;
    this.inFlight = null;
    this.timer = null;
    this.stopped = false;
    this.activationQueue = Promise.resolve();
    this.lastFailure = '';
    this.lastHandoffProbe = 0;
    this.statusTimer = null;

    this.state = {
      status: 'checking',
      message: 'Verifying your Forma Claude access…',
      expiresAt: 0,
      accessType: 'standard',
      licenseId: null,
    };
  }

  get sysDir() {
    return path.join(this.root, '.fc_sys');
  }

  get keyFile() {
    return path.join(this.sysDir, '.fc_k.dat');
  }

  get deviceFile() {
    return path.join(this.sysDir, '.fc_d.dat');
  }

  get pubFile() {
    return path.join(this.sysDir, '.fc_pub.dat');
  }

  get handoffFile() {
    return path.join(this.sysDir, '.fc_handoff');
  }

  get statusFile() {
    return path.join(this.sysDir, '.fc_state.json');
  }

  hideSys() {
    if (process.platform === 'win32') {
      execFile('attrib.exe', ['+h', '+s', this.sysDir], { windowsHide: true, timeout: 4000 }, () => {});
    }
  }

  async ensureDevice() {
    await fs.promises.mkdir(this.sysDir, { recursive: true, mode: 0o700 });
    this.hideSys();
    try {
      await fs.promises.writeFile(this.deviceFile, crypto.randomBytes(32).toString('hex'), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const device = (await fs.promises.readFile(this.deviceFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(device)) {
      throw new Error('The installation identifier is damaged. Reinstall Forma Claude.');
    }
    this.device = device;
  }

  /** The public key is pinned at build time; a cached copy is a fallback only. */
  async loadPublicKey() {
    const pinned = process.env.FORMA_PUBLIC_KEY || null;
    if (pinned) {
      this.publicKey = crypto.createPublicKey(pinned);
      return;
    }
    try {
      const cached = await fs.promises.readFile(this.pubFile, 'utf8');
      this.publicKey = crypto.createPublicKey(cached);
      return;
    } catch {}
    try {
      const res = await fetch(`${this.apiUrl}/v1/public-key`, { signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      if (json?.publicKey) {
        this.publicKey = crypto.createPublicKey(json.publicKey);
        await fs.promises.writeFile(this.pubFile, json.publicKey, { mode: 0o600 });
      }
    } catch {}
  }

  async loadKey() {
    try {
      const blob = await fs.promises.readFile(this.keyFile);
      if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('Windows encrypted storage is unavailable.');
      const value = this.safeStorage.decryptString(blob);
      if (typeof value === 'string' && value.startsWith(`${KEY_PREFIX}.`)) this.key = value;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.key = '';
        this.lastFailure = 'The saved key could not be decrypted. Enter it again.';
      }
    }
  }

  /**
   * Consume a key handed over by the Forma Launcher. The launcher writes a
   * short-lived one-shot file; this reads it, stores the key with DPAPI and
   * deletes the handoff immediately. Never leaves the key in plain text.
   */
  async consumeHandoff() {
    const now = Date.now();
    if (now - (this.lastHandoffProbe || 0) < 5000) return false;
    this.lastHandoffProbe = now;
    let raw;
    try {
      raw = await fs.promises.readFile(this.handoffFile, 'utf8');
    } catch {
      return false;
    }
    await fs.promises.rm(this.handoffFile, { force: true }).catch(() => {});
    try {
      const data = JSON.parse(raw);
      const key = String(data?.key || '').trim();
      if (data?.v !== 1 || !/^FORMA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
        this.lastFailure = 'The key handed over by Forma was not valid. Enter it again.';
        return false;
      }
      await this.saveKey(key);
      this.key = key;
      this.lease = null;
      this.lastFailure = '';
      this.set({ status: 'checking', message: 'Activating the key from Forma...' });
      return true;
    } catch (err) {
      this.lastFailure = err.message || 'The handed-over key could not be stored.';
      return false;
    }
  }

  /** Publish a secret-free status file the launcher can read. */
  publishStatus() {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      const snap = this.snapshot();
      const body = JSON.stringify({
        v: 1,
        status: snap.status,
        accessType: snap.accessType,
        licenseId: snap.licenseId,
        expiresAt: snap.expiresAt,
        device: snap.device,
        updatedAt: Date.now(),
      });
      fs.promises.mkdir(this.sysDir, { recursive: true, mode: 0o700 })
        .then(() => fs.promises.writeFile(this.statusFile, body, { mode: 0o600 }))
        .catch(() => {});
    }, 1200);
    this.statusTimer.unref?.();
  }

  async saveKey(raw) {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Windows encrypted storage is unavailable. Forma Claude cannot store the key.');
    }
    const blob = this.safeStorage.encryptString(raw);
    await fs.promises.mkdir(this.sysDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.keyFile}.tmp`;
    await fs.promises.writeFile(tmp, blob, { mode: 0o600 });
    await fs.promises.rename(tmp, this.keyFile);
    this.hideSys();
  }

  async clearKey() {
    this.key = '';
    this.lease = null;
    await fs.promises.rm(this.keyFile, { force: true }).catch(() => {});
  }

  snapshot() {
    const now = nowMs();
    let status = this.state.status;
    let remainingMs = 0;
    let message = this.state.message;

    if (status === 'active') {
      if (!this.lease) {
        // Never dead-end when key is valid but lease is still reconnecting (§4.5)
        status = 'active';
        message = 'Active, reconnecting lease…';
      } else {
        const hardDeadline = Math.min(this.lease.validUntil + OFFLINE_GRACE_MS, this.lease.licenseExpiresAt);
        remainingMs = Math.max(0, hardDeadline - now);
        if (this.lease.licenseExpiresAt <= now) {
          status = 'expired';
          remainingMs = 0;
          message = 'Your key has expired. Get a new key to continue.';
        } else if (remainingMs <= 0) {
          status = 'offline';
          remainingMs = 0;
          message = 'The Forma server could not be reached. Reconnect to continue.';
        }
      }
    }

    return {
      status,
      message,
      expiresAt: status === 'active' && this.lease ? this.lease.licenseExpiresAt : 0,
      remainingMs,
      accessType: this.state.accessType || 'standard',
      licenseId: this.state.licenseId || null,
      device: this.device,
      shortDevice: formatShortDevice(this.device),
      maskedKey: maskKey(this.key),
      hasKey: Boolean(this.key),
      leaseMissing: status === 'active' && !this.lease,
      rateLimitUntil: this.state.rateLimitUntil || 0,
      appVersion: this.appVersion,
      gatewayUrl: `${this.apiUrl}/get-key`,
      checkedAt: this.lastServerAt,
    };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    if (patch.status && patch.status !== 'active') this.lease = null;
    const snap = this.snapshot();
    this.publishStatus();
    this.emit('change', snap);
    return snap;
  }

  async postJson(pathname, body, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `FormaClaude/${this.appVersion}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { res, json };
    } finally {
      clearTimeout(timer);
    }
  }

  async check() {
    if (this.stopped) return this.snapshot();
    if (this.inFlight) return this.inFlight;

    const task = (async () => {
      if (!this.device) await this.ensureDevice();
      if (!this.publicKey) await this.loadPublicKey();
      await this.consumeHandoff();

      if (!this.key) {
        const snap = this.set({
          status: 'invalid',
          message: this.lastFailure || 'Enter your Forma Claude key to continue.',
          expiresAt: 0,
        });
        this.schedule(RENEW_MS);
        return snap;
      }

      const nonce = crypto.randomBytes(32).toString('hex');
      const idempotencyKey = crypto.createHash('sha256').update(`${this.device}:${this.key}:${Math.floor(nowMs() / 10000)}`).digest('hex').slice(0, 32);

      try {
        const { res, json } = await this.postJson(
          '/v1/validate',
          {
            device: this.device,
            nonce,
            key: this.key,
            appVersion: this.appVersion,
          },
          { 'idempotency-key': idempotencyKey },
        );

        if (res.status === 429) {
          const retrySec = Number(res.headers.get('retry-after') || 15);
          const snap = this.set({
            status: 'rate-limited',
            message: `Too many requests. Retrying in ${retrySec}s.`,
            rateLimitUntil: nowMs() + retrySec * 1000,
            expiresAt: 0,
          });
          this.schedule(Math.max(5000, retrySec * 1000));
          return snap;
        }

        if (!res.ok || !json?.envelope) {
          throw new Error('The license server rejected the request.');
        }

        const receipt = verifyEnvelope(json.envelope, { publicKey: this.publicKey, device: this.device, nonce });
        this.lastServerAt = nowMs();

        if (receipt.status !== 'active') {
          const msg = String(receipt.message || 'License invalid.');
          const status = /revok/i.test(msg) ? 'revoked' : /expired/i.test(msg) ? 'expired' : 'invalid';
          const snap = this.set({ status, message: msg, expiresAt: 0, licenseId: null, rateLimitUntil: 0 });
          this.schedule(RETRY_MS);
          return snap;
        }

        this.lease = {
          licenseId: receipt.licenseId || null,
          licenseExpiresAt: receipt.licenseExpiresAt,
          validUntil: receipt.validUntil,
          accessType: receipt.accessType || 'standard',
          features: receipt.features || [],
          issuedAt: receipt.issuedAt,
        };

        const snap = this.set({
          status: 'active',
          message: 'Access active.',
          expiresAt: receipt.licenseExpiresAt,
          accessType: receipt.accessType || 'standard',
          licenseId: receipt.licenseId || null,
        });
        this.lastFailure = '';
        this.schedule(RENEW_MS);
        return snap;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'The license server could not be reached.';
        if (this.lease && this.lease.licenseExpiresAt > nowMs()) {
          if (this.lease.validUntil + OFFLINE_GRACE_MS > nowMs()) {
            this.set({ status: 'active', message: 'Access active (renewing).', expiresAt: this.lease.licenseExpiresAt });
            this.schedule(RETRY_MS);
            return this.snapshot();
          }
          const snap = this.set({
            status: 'offline',
            message: 'The Forma server could not be reached. Reconnect to continue.',
            expiresAt: 0,
          });
          this.schedule(RETRY_MS);
          return snap;
        }
        const snap = this.set({
          status: /signature|match|response/i.test(reason) ? 'security-blocked' : 'offline',
          message: reason,
          expiresAt: 0,
        });
        this.schedule(RETRY_MS);
        return snap;
      }
    })();

    this.inFlight = task;
    try {
      return await task;
    } finally {
      if (this.inFlight === task) this.inFlight = null;
    }
  }

  schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check().catch(() => {});
    }, Math.max(2000, delay));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async activate(rawKey) {
    const key = String(rawKey || '').trim().replace(/\s+/g, '');
    if (!/^FORMA1\.[A-Za-z0-9_-]{20,4000}\.[A-Za-z0-9_-]{40,200}$/.test(key)) {
      return { ok: false, message: 'That is not a Forma key. It must start with FORMA1.' };
    }

    const run = async () => {
      if (this.inFlight) {
        try {
          await this.inFlight;
        } catch {}
      }
      const previous = this.key;
      this.key = key;
      this.lease = null;
      this.lastFailure = '';
      this.set({ status: 'checking', message: 'Activating your key…', expiresAt: 0 });

      const snap = await this.check();
      if (snap.status === 'active') {
        try {
          await this.saveKey(key);
        } catch (err) {
          this.key = previous;
          this.lease = null;
          return {
            ok: false,
            message: err.message || 'The key could not be stored securely.',
            state: this.set({ status: 'invalid', message: 'The key could not be stored securely.' }),
          };
        }
        return { ok: true, message: 'Access activated.', state: this.snapshot() };
      }

      this.key = previous || '';
      return { ok: false, message: snap.message || 'This key is not valid.', state: this.snapshot() };
    };

    const next = this.activationQueue.then(run, run);
    this.activationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async refresh() {
    this.lease = null;
    this.set({ status: 'checking', message: 'Checking access…' });
    return this.check();
  }

  /**
   * Fetch a short-lived lease plus the sealed protected module.
   * Only meaningful while the license is active. Returns null on any failure —
   * a missing lease must degrade to "gated features off", never to a crash.
   */
  async fetchLease() {
    if (!this.key) return null;
    try {
      const { res, json } = await this.postJson('/v1/lease', { key: this.key, deviceId: this.device });
      if (!res.ok || !json?.ok) return null;
      return {
        lease: json.lease,
        leaseSecret: json.leaseSecret,
        sealedModule: json.sealedModule || null,
        features: json.features || [],
        ttlMs: json.ttlMs || 0,
      };
    } catch {
      return null;
    }
  }

  async initialize() {
    await this.ensureDevice();
    await this.loadPublicKey();
    await this.loadKey();
    await this.consumeHandoff();
    return this.check();
  }

  /** Features the current lease grants. Empty when not active. */
  features() {
    return this.snapshot().status === 'active' ? this.lease?.features || [] : [];
  }

  hasFeature(name) {
    return this.features().includes(name);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { FormaLicense, verifyEnvelope, KEY_PREFIX, LEASE_DOMAIN, AUDIENCE };
