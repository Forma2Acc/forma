'use strict';
/**
 * Forma Launcher — Self-Healing Payload Engine (§4.3).
 *
 * Guarantees:
 *  - Verifies Ed25519-signed forma-manifest.json (domain: FORMA-MANIFEST-v1\n).
 *  - Content-addressed blob cache (%LOCALAPPDATA%\Forma\cache\blobs\<sha256>).
 *  - Fast-path boot check (<2s): only hashes files whose (size, mtimeMs) changed.
 *  - Repairs corrupt/missing files from blob cache first, else HTTP Range resume.
 *  - Re-verifies generation Merkle root before accepting.
 *  - A/B generation directories + junction switch + automatic rollback on double failure
 *    or failed post-heal smoke test (--forma-selftest, 20s timeout).
 *  - Never loops on a known-bad generation (persisted in bad-generations.json).
 *  - Never downloads an installer to fix a payload.
 *  - Append-only rotated log at %APPDATA%\Forma\logs\heal.log.
 */

let fs;
try {
  fs = process.versions && process.versions.electron ? require('original-fs') : require('node:fs');
} catch {
  fs = require('node:fs');
}
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MANIFEST_DOMAIN = 'FORMA-MANIFEST-v1';
const MAX_LOG_BYTES = 1024 * 1024;
const SMOKE_TIMEOUT_MS = 20_000;

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => h.update(chunk));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function computeMerkleRoot(files) {
  const leaves = (Array.isArray(files) ? files : [])
    .slice()
    .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
    .map((f) => sha256Buffer(Buffer.from(`${f.path}|${f.sha256}|${Number(f.size || 0)}`, 'utf8')));
  if (!leaves.length) return sha256Buffer(Buffer.from('empty', 'utf8'));
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256Buffer(Buffer.from(`${left}:${right}`, 'utf8')));
    }
    level = next;
  }
  return level[0];
}

function signManifest(manifestObj, privateKeyPem) {
  const payload = JSON.stringify({
    generation: manifestObj.generation,
    minLauncher: manifestObj.minLauncher || '1.9.0',
    createdAt: manifestObj.createdAt || new Date().toISOString(),
    merkleRoot: manifestObj.merkleRoot || computeMerkleRoot(manifestObj.files || []),
    smokeExe: manifestObj.smokeExe || null,
    files: manifestObj.files || [],
  });
  const priv = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(`${MANIFEST_DOMAIN}\n${payload}`, 'utf8'), priv).toString('base64url');
  return { payload, signature: sig };
}

function verifyManifestEnvelope(envelope, publicKeyPem) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('malformed manifest envelope');
  }
  const pub = crypto.createPublicKey(publicKeyPem);
  const ok = crypto.verify(
    null,
    Buffer.from(`${MANIFEST_DOMAIN}\n${envelope.payload}`, 'utf8'),
    pub,
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!ok) throw new Error('manifest signature invalid');
  const data = JSON.parse(envelope.payload);
  if (!data || !data.generation || !Array.isArray(data.files)) {
    throw new Error('manifest missing generation or files');
  }
  const expectedRoot = computeMerkleRoot(data.files);
  if (data.merkleRoot && data.merkleRoot !== expectedRoot) {
    throw new Error('manifest merkleRoot mismatch');
  }
  return { ...data, merkleRoot: expectedRoot };
}

function resolveSafePath(rootDir, relPath) {
  const cleanRel = String(relPath || '').trim();
  if (!cleanRel || path.isAbsolute(cleanRel) || /^[a-zA-Z]:/.test(cleanRel)) {
    throw new Error(`unsafe manifest path: ${relPath}`);
  }
  const root = path.resolve(rootDir);
  const full = path.resolve(root, cleanRel);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path traversal rejected: ${relPath}`);
  }
  return full;
}

async function renameAtomicWithRetry(tmp, dest) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      if ((err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') && attempt < 3) {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
        continue;
      }
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

async function writeFileAtomic(dest, data) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  await renameAtomicWithRetry(tmp, dest);
}

async function copyFileAtomic(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    await fsp.copyFile(src, tmp);
    let fh = null;
    try {
      fh = await fsp.open(tmp, 'r+');
      await fh.sync();
    } catch {
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  await renameAtomicWithRetry(tmp, dest);
}

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
}

async function switchJunctionAtomic(linkPath, targetDir) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    const st = await fsp.lstat(linkPath);
    if (st.isSymbolicLink()) {
      // Never use recursive rm on a junction/symlink; remove only the reparse point.
      try {
        await fsp.unlink(linkPath);
      } catch {
        await fsp.rmdir(linkPath);
      }
    } else if (st.isDirectory()) {
      await fsp.rmdir(linkPath);
    } else {
      await fsp.unlink(linkPath);
    }
  } catch {}
  await fsp.symlink(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function runSmokeTest(exePath, args = ['--forma-selftest'], timeoutMs = SMOKE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!exePath || !fs.existsSync(exePath)) {
      return resolve({ ok: false, code: -1, reason: 'smoke executable missing' });
    }
    const isJs = /\.(cjs|mjs|js)$/i.test(exePath);
    const bin = isJs ? process.execPath : exePath;
    const argv = isJs ? [exePath, ...args] : args;
    execFile(bin, argv, { windowsHide: true, timeout: timeoutMs }, (err) => {
      if (!err) return resolve({ ok: true, code: 0 });
      resolve({ ok: false, code: typeof err.code === 'number' ? err.code : 1, reason: String(err.message || err) });
    });
  });
}

async function downloadWithRangeResume(url, destFile, expectedSha256, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== 'function') throw new Error('download url unavailable');
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  const partFile = `${destFile}.part`;
  let existingSize = 0;
  try {
    const st = await fsp.stat(partFile);
    existingSize = st.size;
  } catch {}

  const headers = existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {};
  const res = await fetchImpl(url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status === 206 && existingSize > 0) {
    await fsp.appendFile(partFile, buf);
  } else {
    await fsp.writeFile(partFile, buf);
  }
  const actual = await sha256File(partFile);
  if (actual !== expectedSha256) {
    await fsp.unlink(partFile).catch(() => {});
    throw new Error(`downloaded sha256 mismatch (${actual.slice(0, 12)} != ${expectedSha256.slice(0, 12)})`);
  }
  await fsp.rename(partFile, destFile);
  return actual;
}

function createSelfHealer({
  localAppData = process.env.LOCALAPPDATA || '',
  appData = process.env.APPDATA || '',
  publicKeyPem,
  fetchImpl = globalThis.fetch,
  killRunning = async () => {},
  onToast = () => {},
} = {}) {
  const formaLocal = path.join(localAppData, 'Forma');
  const blobsDir = path.join(formaLocal, 'cache', 'blobs');
  const verifyStatePath = path.join(formaLocal, 'cache', 'verify-state.json');
  const generationsDir = path.join(formaLocal, 'generations');
  const currentLink = path.join(formaLocal, 'current');
  const statePath = path.join(formaLocal, 'heal-state.json');
  const badGenPath = path.join(formaLocal, 'bad-generations.json');
  const logDir = path.join(appData, 'Forma', 'logs');
  const logPath = path.join(logDir, 'heal.log');

  async function appendHealLog(summary) {
    try {
      await fsp.mkdir(logDir, { recursive: true });
      try {
        const st = await fsp.stat(logPath);
        if (st.size > MAX_LOG_BYTES) {
          await fsp.rename(logPath, `${logPath}.1`).catch(() => {});
        }
      } catch {}
      const line = `[${new Date().toISOString()}] ${summary}\n`;
      await fsp.appendFile(logPath, line, 'utf8');
    } catch {}
  }

  async function storeBlob(filePath, knownSha = null) {
    const sha = knownSha || (await sha256File(filePath));
    const dest = path.join(blobsDir, sha);
    if (!fs.existsSync(dest)) {
      await copyFileAtomic(filePath, dest);
    }
    return sha;
  }

  async function seedGenerationFromDir(generation, srcDir, manifestFiles) {
    const genDir = path.join(generationsDir, generation);
    await fsp.mkdir(genDir, { recursive: true });
    for (const f of manifestFiles) {
      const src = resolveSafePath(srcDir, f.path);
      const dst = resolveSafePath(genDir, f.path);
      if (fs.existsSync(src)) {
        await copyFileAtomic(src, dst);
        await storeBlob(dst, f.sha256);
      }
    }
    await switchJunctionAtomic(currentLink, genDir);
    const state = (await readJsonSafe(statePath, {})) || {};
    state.activeGeneration = generation;
    state.lastGoodGeneration = generation;
    await writeJsonAtomic(statePath, state);
    return genDir;
  }

  async function verifyWholeGeneration(genDir, manifestFiles, expectedRoot) {
    const computed = [];
    for (const f of manifestFiles) {
      const full = resolveSafePath(genDir, f.path);
      if (!fs.existsSync(full)) return { ok: false, reason: `missing ${f.path}` };
      const st = await fsp.stat(full);
      const sha = await sha256File(full);
      if (sha !== f.sha256) return { ok: false, reason: `hash mismatch ${f.path}` };
      computed.push({ path: f.path, sha256: sha, size: st.size });
    }
    const root = computeMerkleRoot(computed);
    if (root !== expectedRoot) return { ok: false, reason: 'merkle root mismatch' };
    return { ok: true, merkleRoot: root };
  }

  /**
   * Main boot heal loop (§4.3.3).
   */
  async function heal({ manifestEnvelope, smokeRunner = runSmokeTest } = {}) {
    const t0 = Date.now();
    await fsp.mkdir(blobsDir, { recursive: true });
    await fsp.mkdir(generationsDir, { recursive: true });

    let manifest;
    try {
      manifest = verifyManifestEnvelope(manifestEnvelope, publicKeyPem);
    } catch (err) {
      const summary = `manifest-invalid error="${err.message}" ms=${Date.now() - t0}`;
      await appendHealLog(summary);
      return { ok: false, reason: err.message, repaired: 0, rolledBack: false };
    }

    const state = (await readJsonSafe(statePath, {})) || {};
    const badGens = (await readJsonSafe(badGenPath, {})) || {};
    const verifyCache = (await readJsonSafe(verifyStatePath, {})) || {};

    if (badGens[manifest.generation]) {
      const fallback = state.lastGoodGeneration && state.lastGoodGeneration !== manifest.generation ? state.lastGoodGeneration : null;
      const summary = `skip-bad-generation gen=${manifest.generation} active=${fallback || 'none'} ms=${Date.now() - t0}`;
      await appendHealLog(summary);
      return {
        ok: Boolean(fallback),
        skippedBad: true,
        generation: fallback || manifest.generation,
        repaired: 0,
        rolledBack: false,
      };
    }

    const genDir = path.join(generationsDir, manifest.generation);
    await fsp.mkdir(genDir, { recursive: true });

    const prevGood = state.lastGoodGeneration && state.lastGoodGeneration !== manifest.generation ? state.lastGoodGeneration : null;

    let repaired = 0;
    let fromBlob = 0;
    let fromNet = 0;
    let hashed = 0;
    let killed = false;
    let lastError = null;

    const rollbackToPrevious = async (reason) => {
      badGens[manifest.generation] = { at: new Date().toISOString(), reason };
      await writeJsonAtomic(badGenPath, badGens);
      if (prevGood && fs.existsSync(path.join(generationsDir, prevGood))) {
        await switchJunctionAtomic(currentLink, path.join(generationsDir, prevGood));
        state.activeGeneration = prevGood;
        await writeJsonAtomic(statePath, state);
        const summary = `rollback from=${manifest.generation} to=${prevGood} reason="${reason}" ms=${Date.now() - t0}`;
        await appendHealLog(summary);
        onToast(`Forma rolled back to generation ${prevGood}`);
        return { ok: true, rolledBack: true, generation: prevGood, badGeneration: manifest.generation, repaired, reason };
      }
      const summary = `heal-failed gen=${manifest.generation} reason="${reason}" ms=${Date.now() - t0}`;
      await appendHealLog(summary);
      return { ok: false, rolledBack: false, generation: manifest.generation, repaired, reason };
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      let attemptFailed = false;
      for (const f of manifest.files) {
        const dest = resolveSafePath(genDir, f.path);
        const cacheKey = `${manifest.generation}:${f.path}`;
        const cached = verifyCache[cacheKey];

        let needsRepair = false;
        if (!fs.existsSync(dest)) {
          needsRepair = true;
        } else {
          const st = await fsp.stat(dest);
          const unchanged = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.sha256 === f.sha256;
          if (!unchanged) {
            hashed += 1;
            const actual = await sha256File(dest);
            if (actual !== f.sha256) {
              needsRepair = true;
            } else {
              verifyCache[cacheKey] = { size: st.size, mtimeMs: st.mtimeMs, sha256: actual };
              await storeBlob(dest, actual);
            }
          }
        }

        if (needsRepair) {
          if (!killed) {
            killed = true;
            await killRunning().catch(() => {});
          }
          const blobFile = path.join(blobsDir, f.sha256);
          try {
            if (fs.existsSync(blobFile) && (await sha256File(blobFile)) === f.sha256) {
              await copyFileAtomic(blobFile, dest);
              fromBlob += 1;
            } else if (f.url) {
              await downloadWithRangeResume(f.url, dest, f.sha256, fetchImpl);
              await storeBlob(dest, f.sha256);
              fromNet += 1;
            } else {
              throw new Error(`blob missing and no url for ${f.path}`);
            }
            const st = await fsp.stat(dest);
            verifyCache[cacheKey] = { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 };
            repaired += 1;
          } catch (err) {
            lastError = String(err?.message || err);
            attemptFailed = true;
          }
        }
      }

      if (!attemptFailed) {
        const merkleCheck =
          repaired > 0 || state.activeGeneration !== manifest.generation
            ? await verifyWholeGeneration(genDir, manifest.files, manifest.merkleRoot)
            : { ok: true, merkleRoot: manifest.merkleRoot };
        if (merkleCheck.ok) {
          lastError = null;
          break;
        }
        lastError = merkleCheck.reason;
      }
      if (attempt === 2) {
        return rollbackToPrevious(lastError || 'verification failed twice');
      }
    }

    await writeJsonAtomic(verifyStatePath, verifyCache);

    // Post-heal smoke test when switching generation or after repairs
    const switching = state.activeGeneration !== manifest.generation;
    if ((switching || repaired > 0) && manifest.smokeExe) {
      const smokePath = resolveSafePath(genDir, manifest.smokeExe);
      const smoke = await smokeRunner(smokePath, ['--forma-selftest'], SMOKE_TIMEOUT_MS);
      if (!smoke.ok) {
        return rollbackToPrevious(`smoke-test failed (code=${smoke.code}): ${smoke.reason || ''}`);
      }
    }

    if (switching || !fs.existsSync(currentLink)) {
      await switchJunctionAtomic(currentLink, genDir);
    }
    state.activeGeneration = manifest.generation;
    state.lastGoodGeneration = manifest.generation;
    state.lastVerifiedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);

    const ms = Date.now() - t0;
    const summary = `ok gen=${manifest.generation} repaired=${repaired} (blob=${fromBlob}, net=${fromNet}) hashed=${hashed} ms=${ms}`;
    await appendHealLog(summary);
    if (repaired > 0) {
      onToast(`Forma repaired ${repaired} payload file${repaired === 1 ? '' : 's'} automatically.`);
    }

    return {
      ok: true,
      generation: manifest.generation,
      repaired,
      fromBlob,
      fromNet,
      hashed,
      rolledBack: false,
      ms,
      logPath,
    };
  }

  return {
    heal,
    storeBlob,
    seedGenerationFromDir,
    paths: { formaLocal, blobsDir, generationsDir, currentLink, statePath, badGenPath, verifyStatePath, logPath },
  };
}

module.exports = {
  MANIFEST_DOMAIN,
  computeMerkleRoot,
  signManifest,
  verifyManifestEnvelope,
  createSelfHealer,
  sha256File,
  runSmokeTest,
};
