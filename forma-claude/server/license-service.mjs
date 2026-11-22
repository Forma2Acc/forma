import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Forma Claude — license service.
 *
 * Everything that matters lives here, server-side:
 *   - key issuance (Ed25519 signed, FORMA1.<payload>.<sig>)
 *   - device binding on first activation
 *   - short-lived leases (15 min) that gate the protected module
 *   - revocation, extension, batch minting
 *
 * The client holds only the public key. Forging a key requires the private key,
 * which never leaves this process.
 */

const KEY_PREFIX = 'FORMA1';
const LEASE_PREFIX = 'FLEASE1';
const LEASE_TTL_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Every key carries a rolling access window. Each successful validation slides
 * the window forward, so a key that is in use never lapses; a key that is idle
 * for the whole window releases its seat and can be reissued by the checkpoint.
 */
const KEY_WINDOW_MS = Math.max(1, Number(process.env.KEY_WINDOW_HOURS || 5)) * 3_600_000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(String(str), 'base64url');
}

function loadOrCreateKeyPair(keyDir) {
  fs.mkdirSync(keyDir, { recursive: true });
  const privPath = path.join(keyDir, 'license-private.pem');
  const pubPath = path.join(keyDir, 'license-public.pem');
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privateKey: crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8')),
      publicKey: crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8')),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  return { privateKey, publicKey };
}

function sign(keyPair, payload) {
  return b64url(crypto.sign(null, Buffer.from(JSON.stringify(payload)), keyPair.privateKey));
}

function verifyWith(publicKey, payload, signature) {
  try {
    return crypto.verify(null, Buffer.from(JSON.stringify(payload)), publicKey, fromB64url(signature));
  } catch {
    return false;
  }
}

/**
 * Storage adapter. Ships with a JSON file store so the service runs with zero
 * infrastructure; the interface is what a Mongo adapter must implement.
 *
 *   get(collection, id) -> object|null
 *   put(collection, id, value)
 *   all(collection) -> object[]
 *   del(collection, id)
 */
function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cache = new Map();
  const fileFor = (c) => path.join(dir, `${c}.json`);
  const load = (c) => {
    if (cache.has(c)) return cache.get(c);
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(fileFor(c), 'utf8'));
    } catch {}
    cache.set(c, data);
    return data;
  };
  const flush = (c) => {
    const data = load(c);
    const tmp = `${fileFor(c)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, fileFor(c));
  };
  return {
    get: (c, id) => load(c)[id] || null,
    put: (c, id, value) => {
      load(c)[id] = value;
      flush(c);
    },
    del: (c, id) => {
      delete load(c)[id];
      flush(c);
    },
    all: (c) => Object.values(load(c)),
  };
}

function createLicenseService({ store, keyDir, tiers = {}, masterSecret = null, moduleSource = null }) {
  const keyPair = loadOrCreateKeyPair(keyDir);
  const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

  // The master secret never leaves the server. It is the root of every per-license
  // module key. If it is missing the service still issues licenses, but the
  // protected module cannot be sealed and the gated features stay off.
  const MASTER_SECRET =
    masterSecret ||
    process.env.FORMA_MASTER_SECRET ||
    (() => {
      const p = path.join(keyDir, 'master.secret');
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
      const s = crypto.randomBytes(48).toString('base64');
      fs.writeFileSync(p, s, { mode: 0o600 });
      return s;
    })();

  const MODULE_SOURCE = moduleSource || null;

  function deriveKey(leaseSecret, deviceId) {
    return Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(leaseSecret, 'base64'),
        Buffer.from(String(deviceId), 'utf8'),
        Buffer.from('forma-protected-v1', 'utf8'),
        32,
      ),
    );
  }

  /** Seal a module for one license/device pair. Same format as forma-protected.cjs. */
  function sealFor(leaseSecret, deviceId, source) {
    const key = deriveKey(leaseSecret, deviceId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(Buffer.from(source, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1, 0);
    return Buffer.concat([Buffer.from('FORMASLD', 'ascii'), header, iv, tag, body]).toString('base64');
  }


  const DEFAULT_TIERS = {
    trial: { hours: 24, features: ['reset', 'archive'] },
    standard: { hours: 40, features: ['reset', 'archive', 'pool'] },
    pro: { hours: 168, features: ['reset', 'archive', 'pool', 'warp', 'priority'] },
  };
  const TIERS = { ...DEFAULT_TIERS, ...tiers };

  // ── key issuance ──────────────────────────────────────────────────────────

  function mint({ tier = 'standard', batch = 'manual', issuedBy = 'admin', count = 1 } = {}) {
    const spec = TIERS[tier];
    if (!spec) throw new Error(`unknown tier: ${tier}`);
    const keys = [];
    for (let i = 0; i < Math.min(count, 500); i++) {
      const id = crypto.randomUUID();
      const payload = {
        v: 1,
        id,
        tier,
        batch,
        hours: spec.hours,
        features: spec.features,
        iat: Date.now(),
        // exp is advisory: activation starts the clock, not minting.
      };
      const key = `${KEY_PREFIX}.${b64url(Buffer.from(JSON.stringify(payload)))}.${sign(keyPair, payload)}`;
      store.put('licenses', id, {
        id,
        key,
        tier,
        batch,
        hours: spec.hours,
        features: spec.features,
        issuedBy,
        issuedAt: Date.now(),
        status: 'unused',
        deviceId: null,
        activatedAt: null,
        expiresAt: null,
        revokedAt: null,
        lastLeaseAt: null,
        leaseCount: 0,
      });
      keys.push({ id, key, tier, hours: spec.hours });
    }
    return keys;
  }

  // ── verification ──────────────────────────────────────────────────────────

  function parseKey(key) {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return { ok: false, reason: 'malformed' };
    let payload;
    try {
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      return { ok: false, reason: 'payload' };
    }
    if (!verifyWith(keyPair.publicKey, payload, parts[2])) return { ok: false, reason: 'signature' };
    return { ok: true, payload };
  }

  /**
   * Activate. First call binds the device; later calls from the same device are
   * idempotent. A different device is rejected unless the license was unbound.
   */
  function activate({ key, deviceId, appVersion = null, platform = null }) {
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8) {
      return { ok: false, error: 'device_required' };
    }
    const parsed = parseKey(key);
    if (!parsed.ok) return { ok: false, error: parsed.reason };

    const record = store.get('licenses', parsed.payload.id);
    if (!record) return { ok: false, error: 'unknown_key' };
    if (record.revokedAt) return { ok: false, error: 'revoked' };
    if (record.deviceId && record.deviceId !== deviceId) return { ok: false, error: 'device_mismatch' };
    if (record.expiresAt && Date.now() > record.expiresAt) return { ok: false, error: 'expired' };

    const now = Date.now();
    if (!record.deviceId) {
      record.deviceId = deviceId;
      record.activatedAt = now;
      record.expiresAt = now + KEY_WINDOW_MS;
      record.status = 'active';
    } else if (record.expiresAt && now < record.expiresAt) {
      // Renewing an active key keeps the same 5-hour window from now.
      record.expiresAt = Math.max(record.expiresAt, now + KEY_WINDOW_MS);
    }
    record.lastSeenAt = now;
    record.appVersion = appVersion;
    record.platform = platform;
    store.put('licenses', record.id, record);

    return {
      ok: true,
      license: {
        id: record.id,
        tier: record.tier,
        features: record.features,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        deviceId: record.deviceId,
      },
    };
  }

  // ── leases ────────────────────────────────────────────────────────────────

  /**
   * A lease is the short-lived token that unlocks the protected module. It is
   * signed independently of the license key, carries the feature set, and is
   * bound to the device so a copied lease does not work elsewhere.
   */
  /**
   * Signed validation envelope. This is what the client actually consumes.
   *
   * The envelope is Ed25519-signed over `FORMA-CLAUDE-LEASE-v1\n<payload>` and
   * echoes the request nonce, so a replay from another request cannot be used.
   */
  function validate({ key, device, nonce, appVersion = null }) {
    const issuedAt = Date.now();
    const parsed = parseKey(key);

    const envelope = (payload) => ({
      payload: JSON.stringify(payload),
      signature: b64url(
        crypto.sign(
          null,
          Buffer.from(`FORMA-CLAUDE-LEASE-v1\n${JSON.stringify(payload)}`, 'utf8'),
          keyPair.privateKey,
        ),
      ),
    });

    const base = { v: 1, aud: 'forma-claude', device, nonce, issuedAt, appVersion };

    if (!parsed.ok) {
      return { ok: true, envelope: envelope({ ...base, status: 'invalid', message: 'That key is not signed by Forma.' }) };
    }

    const record = store.get('licenses', parsed.payload.id);
    if (!record) {
      return { ok: true, envelope: envelope({ ...base, status: 'invalid', message: 'Unknown key.' }) };
    }
    if (record.revokedAt) {
      return { ok: true, envelope: envelope({ ...base, status: 'invalid', message: 'This key was revoked.' }) };
    }
    if (record.deviceId && record.deviceId !== device) {
      return {
        ok: true,
        envelope: envelope({ ...base, status: 'invalid', message: 'This key is bound to another device.' }),
      };
    }
    if (record.expiresAt && issuedAt > record.expiresAt) {
      return { ok: true, envelope: envelope({ ...base, status: 'invalid', message: 'This key has expired.' }) };
    }

    if (!record.deviceId) {
      record.deviceId = device;
      record.activatedAt = issuedAt;
      record.expiresAt = issuedAt + KEY_WINDOW_MS;
      record.status = 'active';
    } else {
      // Sliding window: every accepted validation keeps the key alive for a
      // further full window. An idle key still lapses on its own.
      record.expiresAt = Math.max(record.expiresAt || 0, issuedAt + KEY_WINDOW_MS);
    }
    record.lastSeenAt = issuedAt;
    record.appVersion = appVersion;
    store.put('licenses', record.id, record);

    // Short access window. The client renews well inside it; the license itself
    // is the long-lived thing.
    const validUntil = Math.min(issuedAt + LEASE_TTL_MS, record.expiresAt);

    return {
      ok: true,
      envelope: envelope({
        ...base,
        status: 'active',
        licenseId: record.id,
        accessType: record.tier,
        features: record.features,
        validUntil,
        licenseExpiresAt: record.expiresAt,
        keyWindowMs: KEY_WINDOW_MS,
        policy: { maxDevices: 1, renewMs: 45_000, keyWindowMs: KEY_WINDOW_MS },
      }),
    };
  }

  function lease({ key, deviceId }) {
    const act = activate({ key, deviceId });
    if (!act.ok) return act;

    const record = store.get('licenses', act.license.id);
    const now = Date.now();
    const payload = {
      v: 1,
      lid: record.id,
      did: deviceId,
      tier: record.tier,
      features: record.features,
      iat: now,
      exp: now + LEASE_TTL_MS,
      nonce: crypto.randomBytes(12).toString('base64url'),
    };
    record.lastLeaseAt = now;
    record.leaseCount = (record.leaseCount || 0) + 1;
    store.put('licenses', record.id, record);

    // Per-license secret: HMAC(master, licenseId). Stable for the license, so a
    // sealed module can be built once and reused, and useless without a lease.
    const leaseSecret = crypto
      .createHmac('sha256', MASTER_SECRET)
      .update(`lease:${record.id}`)
      .digest('base64');

    // Seal the protected module for this license on first lease, then cache it.
    // A rebind to another device invalidates the cache, because the blob is
    // sealed against the device id.
    let sealedModule = record.sealedModule?.deviceId === deviceId ? record.sealedModule.blob : null;
    if (!sealedModule && MODULE_SOURCE) {
      sealedModule = sealFor(leaseSecret, deviceId, MODULE_SOURCE);
      record.sealedModule = { deviceId, blob: sealedModule };
    }

    return {
      ok: true,
      lease: `${LEASE_PREFIX}.${b64url(Buffer.from(JSON.stringify(payload)))}.${sign(keyPair, payload)}`,
      leaseSecret,
      sealedModule,
      payload,
      ttlMs: LEASE_TTL_MS,
      features: record.features,
    };
  }

  function verifyLease(token, { deviceId } = {}) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== LEASE_PREFIX) return { ok: false, reason: 'malformed' };
    let payload;
    try {
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      return { ok: false, reason: 'payload' };
    }
    if (!verifyWith(keyPair.publicKey, payload, parts[2])) return { ok: false, reason: 'signature' };
    if (payload.exp + CLOCK_SKEW_MS < Date.now()) return { ok: false, reason: 'expired' };
    if (deviceId && payload.did !== deviceId) return { ok: false, reason: 'device_mismatch' };
    const record = store.get('licenses', payload.lid);
    if (!record) return { ok: false, reason: 'unknown_license' };
    if (record.revokedAt) return { ok: false, reason: 'revoked' };
    return { ok: true, payload, license: record };
  }

  // ── admin operations ──────────────────────────────────────────────────────

  function revoke(id, reason = 'admin') {
    const record = store.get('licenses', id);
    if (!record) return { ok: false, error: 'not_found' };
    record.revokedAt = Date.now();
    record.revokedReason = reason;
    record.status = 'revoked';
    store.put('licenses', id, record);
    return { ok: true };
  }

  function unrevoke(id) {
    const record = store.get('licenses', id);
    if (!record) return { ok: false, error: 'not_found' };
    record.revokedAt = null;
    record.revokedReason = null;
    record.status = record.deviceId ? 'active' : 'unused';
    store.put('licenses', id, record);
    return { ok: true };
  }

  function unbind(id) {
    const record = store.get('licenses', id);
    if (!record) return { ok: false, error: 'not_found' };
    record.deviceId = null;
    record.activatedAt = null;
    record.expiresAt = null;
    record.sealedModule = null;
    record.status = 'unused';
    store.put('licenses', id, record);
    return { ok: true };
  }

  function extend(id, hours) {
    const record = store.get('licenses', id);
    if (!record) return { ok: false, error: 'not_found' };
    const base = record.expiresAt || Date.now();
    record.expiresAt = base + Number(hours) * 3600 * 1000;
    record.hours = (record.hours || 0) + Number(hours);
    store.put('licenses', id, record);
    return { ok: true, expiresAt: record.expiresAt };
  }

  function remove(id) {
    store.del('licenses', id);
    return { ok: true };
  }

  function list({ status, batch, limit = 200, offset = 0 } = {}) {
    let rows = store.all('licenses');
    if (status) rows = rows.filter((r) => r.status === status);
    if (batch) rows = rows.filter((r) => r.batch === batch);
    rows.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }

  function overview() {
    const rows = store.all('licenses');
    const now = Date.now();
    return {
      total: rows.length,
      unused: rows.filter((r) => r.status === 'unused').length,
      active: rows.filter((r) => r.status === 'active' && !r.revokedAt && (!r.expiresAt || r.expiresAt > now)).length,
      expired: rows.filter((r) => r.expiresAt && r.expiresAt <= now).length,
      revoked: rows.filter((r) => r.revokedAt).length,
      devices: new Set(rows.map((r) => r.deviceId).filter(Boolean)).size,
      batches: [...new Set(rows.map((r) => r.batch))].filter(Boolean),
    };
  }

  function exportBatch(batch) {
    return store
      .all('licenses')
      .filter((r) => r.batch === batch)
      .map((r) => r.key)
      .join('\n');
  }

  /**
   * Sign a release manifest. The updater refuses anything that is not signed
   * over `FORMA-CLAUDE-RELEASE-v1\n<payload>` by this key.
   */
  function signRelease(payload) {
    const body = JSON.stringify(payload);
    const signature = b64url(
      crypto.sign(null, Buffer.from(`FORMA-CLAUDE-RELEASE-v1\n${body}`, 'utf8'), keyPair.privateKey),
    );
    const envelope = { payload: body, signature };
    store.put('config', 'release', envelope);
    return envelope;
  }

  return {
    publicKeyPem: publicPem,
    mint,
    activate,
    validate,
    lease,
    verifyLease,
    parseKey,
    revoke,
    unrevoke,
    unbind,
    extend,
    remove,
    list,
    overview,
    exportBatch,
    signRelease,
    tiers: TIERS,
    KEY_PREFIX,
    LEASE_PREFIX,
    LEASE_TTL_MS,
    KEY_WINDOW_MS,
  };
}

export { createLicenseService, createFileStore, loadOrCreateKeyPair, KEY_WINDOW_MS };
