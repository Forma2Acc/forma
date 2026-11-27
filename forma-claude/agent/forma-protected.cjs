'use strict';
/**
 * Forma Claude — protected module loader.
 *
 * The gated features (reset engine, chat store, pool, WARP control) are not
 * shipped as readable JavaScript. They are sealed into an AES-256-GCM blob.
 *
 * The decryption key is derived from the server's lease:
 *
 *     key = HKDF-SHA256(leaseSecret, salt = deviceId, info = "forma-protected-v1")
 *
 * `leaseSecret` is returned by the license server alongside the lease and is
 * never stored on disk. Consequence: a client that patches out the license
 * check still cannot decrypt the module, because it never received the secret.
 *
 * Honest limit: a determined attacker can dump memory after decryption. This
 * raises cost; it does not make the module unreadable. Never claim otherwise.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SEAL_VERSION = 1;
const HKDF_INFO = 'forma-protected-v1';
const MAGIC = Buffer.from('FORMASLD', 'ascii');

function deriveKey(leaseSecret, deviceId) {
  if (!leaseSecret || !deviceId) throw new Error('lease secret and device id are required');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(leaseSecret, 'base64'),
      Buffer.from(String(deviceId), 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      32,
    ),
  );
}

/**
 * Seal a plaintext module into a .fsl file.
 * Used by the build pipeline only; never shipped to clients.
 */
function sealModule({ source, leaseSecret, deviceId, outFile }) {
  const key = deriveKey(leaseSecret, deviceId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(source, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(4);
  header.writeUInt32BE(SEAL_VERSION, 0);

  const blob = Buffer.concat([MAGIC, header, iv, tag, body]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, blob, { mode: 0o644 });
  return { bytes: blob.length, sha256: crypto.createHash('sha256').update(blob).digest('hex') };
}

function readBlob(file) {
  const raw = fs.readFileSync(file);
  if (raw.length < MAGIC.length + 4 + 12 + 16) throw new Error('sealed module truncated');
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('sealed module has a bad header');
  const version = raw.readUInt32BE(MAGIC.length);
  if (version !== SEAL_VERSION) throw new Error(`unsupported seal version ${version}`);
  let p = MAGIC.length + 4;
  const iv = raw.subarray(p, p + 12);
  p += 12;
  const tag = raw.subarray(p, p + 16);
  p += 16;
  return { iv, tag, body: raw.subarray(p) };
}

/**
 * Open and evaluate a sealed module.
 *
 * @param {object} opts
 * @param {string} opts.file         path to the .fsl blob
 * @param {string} opts.leaseSecret  base64 secret from the license lease response
 * @param {string} opts.deviceId     device id the lease is bound to
 * @param {object} opts.sandbox      globals the module may use (require, console, …)
 * @returns {object} the module's exports
 */
function openModule({ file, leaseSecret, deviceId, sandbox = {} }) {
  const key = deriveKey(leaseSecret, deviceId);
  const { iv, tag, body } = readBlob(file);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let source;
  try {
    source = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered blob. Both are fatal and both look the same.
    throw new Error('sealed module could not be opened');
  }

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    fetch,
    ...sandbox,
  });

  const script = new vm.Script(source, { filename: path.basename(file) });
  script.runInContext(context, { timeout: 20000 });
  return module.exports;
}

/**
 * Client-side gate. Holds the decrypted module in memory only.
 * A revoked lease clears it.
 */
function createProtectedGate({ file, sandbox }) {
  let handle = null;

  function unlock({ leaseSecret, deviceId }) {
    lock();
    handle = openModule({ file, leaseSecret, deviceId, sandbox });
    return handle;
  }

  function lock() {
    handle = null;
  }

  function get() {
    return handle;
  }

  function isUnlocked() {
    return Boolean(handle);
  }

  return { unlock, lock, get, isUnlocked };
}

module.exports = { sealModule, openModule, createProtectedGate, deriveKey, HKDF_INFO };
