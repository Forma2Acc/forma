'use strict';
// Loads modules that ship encrypted (sealed.bin). The content key is never stored
// on disk or in this archive: it arrives inside a signed, nonce-bound lease and
// only exists in memory while the license is active.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('FSL1');
const HEADER = 4 + 8 + 12 + 16;

function readSealId(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(12);
      if (fs.readSync(fd, head, 0, 12, 0) !== 12 || !head.subarray(0, 4).equals(MAGIC)) return '';
      return head.subarray(4, 12).toString('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function sealFiles(files, key, sealIdHex = crypto.randomBytes(8).toString('hex')) {
  const id = Buffer.from(sealIdHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, id]));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ files }), 'utf8')), cipher.final()]);
  return { id: sealIdHex, blob: Buffer.concat([MAGIC, id, iv, cipher.getAuthTag(), ct]) };
}

function unsealFiles(blob, key) {
  if (blob.length <= HEADER || !blob.subarray(0, 4).equals(MAGIC)) throw Error('Sealed module is invalid.');
  const id = blob.subarray(4, 12);
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(12, 24));
  d.setAAD(Buffer.concat([MAGIC, id]));
  d.setAuthTag(blob.subarray(24, 40));
  const plain = Buffer.concat([d.update(blob.subarray(HEADER)), d.final()]);
  return JSON.parse(plain.toString('utf8')).files;
}

function createSealedLoader({ dir, file = path.join(dir, 'sealed.bin') }) {
  const id = readSealId(file);
  let cache = null;
  return {
    id,
    isLoaded: () => !!cache,
    clear: () => {
      cache = null;
    },
    load(license) {
      if (cache) return cache;
      const key = license?.getSealKey?.();
      if (!key) throw Error('Forma is locked. An active license is required to load this feature.');
      let files;
      try {
        files = unsealFiles(fs.readFileSync(file), key);
      } catch {
        throw Error('Forma could not unlock its tool module. Update or reinstall the official Forma release.');
      } finally {
        key.fill(0);
      }
      const sealedRequire = Module.createRequire(path.join(dir, 'sealed-host.cjs'));
      const exportsByName = Object.create(null);
      const load = (name) => {
        if (name.endsWith('.json')) {
          if (exportsByName[name]) return exportsByName[name].exports;
          const parsed = JSON.parse(files[name]);
          exportsByName[name] = { exports: parsed };
          return parsed;
        }
        if (exportsByName[name]) return exportsByName[name].exports;
        const filename = path.join(dir, name);
        const mod = { exports: {} };
        exportsByName[name] = mod;
        const fn = vm.runInThisContext(Module.wrap(files[name]), { filename });
        const req = (request) => {
          const clean = String(request).replace(/^\.\//, '');
          if (Object.hasOwn(files, clean)) return load(clean);
          return sealedRequire(request);
        };
        fn.call(mod.exports, mod.exports, req, mod, filename, dir);
        return mod.exports;
      };
      const out = {};
      for (const name of Object.keys(files)) out[name] = load(name);
      cache = out;
      return cache;
    },
  };
}

module.exports = { createSealedLoader, sealFiles, unsealFiles, readSealId };
