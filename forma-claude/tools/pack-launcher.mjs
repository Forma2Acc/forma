/**
 * Repack the Forma Launcher bundle and re-seal it.
 *
 *   node tools/pack-launcher.mjs --dry-run
 *   node tools/pack-launcher.mjs
 *
 * The installed launcher runs with Electron's embedded ASAR integrity fuse
 * enabled: Forma.exe contains a JSON record with the SHA-256 of the app.asar
 * header. A plain repack changes that header, so this tool packs the source
 * into a new app.asar, computes the new header digest and rewrites the same
 * 64-hex value inside Forma.exe in place (same length, no layout change).
 *
 * Everything is backed up under forma-claude/build/launcher-backup/ before the
 * installed copy is touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');

const asarRequire = createRequire(path.join(repo, 'claude-reset', 'package.json'));
const asar = asarRequire('@electron/asar');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const srcDir = path.resolve(arg('dir', path.join(root, 'launcher')));
const installDir = path.resolve(
  arg('install', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'forma')),
);
const buildDir = path.join(root, 'build');
const outAsar = path.join(buildDir, 'app.asar');
const backupDir = path.join(buildDir, 'launcher-backup');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** SHA-256 of the ASAR header JSON, exactly what Electron's fuse checks. */
function asarHeaderHash(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 16) throw new Error('app.asar is too small to be valid.');
  const headerSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  if (jsonSize <= 0 || 16 + jsonSize > buf.length) throw new Error('app.asar header is invalid.');
  const header = buf.subarray(16, 16 + jsonSize);
  return { hash: sha256(header), headerSize, jsonSize, total: buf.length };
}

const ASAR_MARKER = Buffer.from(
  '"file":"resources\\\\app.asar","alg":"SHA256","value":"',
  'latin1',
);

function resealExeBytes(exePath, headerHash) {
  const buf = fs.readFileSync(exePath);
  const at = buf.indexOf(ASAR_MARKER);
  if (at < 0) throw new Error('The ASAR integrity record was not found inside Forma.exe.');
  const start = at + ASAR_MARKER.length;
  const current = buf.subarray(start, start + 64).toString('latin1');
  if (!/^[a-f0-9]{64}$/.test(current)) {
    throw new Error(`The embedded ASAR digest is not a SHA-256 hex value (${current.slice(0, 16)}...).`);
  }
  if (current === headerHash) return { changed: false, previous: current, bytes: null };
  Buffer.from(headerHash, 'latin1').copy(buf, start);
  return { changed: true, previous: current, bytes: buf };
}

function ensureCleanTarget(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Launcher directory not found: ${dir}`);
  const exe = path.join(dir, 'Forma.exe');
  const asarFile = path.join(dir, 'resources', 'app.asar');
  if (!fs.existsSync(exe)) throw new Error(`Forma.exe not found in ${dir}`);
  if (!fs.existsSync(asarFile)) throw new Error(`resources/app.asar not found in ${dir}`);
  return { exe, asarFile };
}

function isRunning() {
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Forma.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 8000 },
    ).toString().toLowerCase();
    return out.includes('"forma.exe"');
  } catch {
    return false;
  }
}

async function main() {
  const { exe, asarFile } = ensureCleanTarget(installDir);
  if (isRunning()) {
    throw new Error('Forma is running. Quit the launcher, then run this again.');
  }

  fs.mkdirSync(buildDir, { recursive: true });
  if (fs.existsSync(outAsar)) fs.rmSync(outAsar, { force: true });
  await asar.createPackage(srcDir, outAsar);
  const built = asarHeaderHash(outAsar);

  const installed = asarHeaderHash(asarFile);
  const exeBytes = fs.readFileSync(exe);
  const at = exeBytes.indexOf(ASAR_MARKER);
  if (at < 0) throw new Error('Forma.exe does not carry an ASAR integrity record.');
  const embedded = exeBytes
    .subarray(at + ASAR_MARKER.length, at + ASAR_MARKER.length + 64)
    .toString('latin1');

  console.log(`source       ${srcDir}`);
  console.log(`install      ${installDir}`);
  console.log(`new asar     ${built.total} bytes  header ${built.hash.slice(0, 16)}...`);
  console.log(`old asar     ${installed.total} bytes  header ${installed.hash.slice(0, 16)}...`);
  console.log(`embedded     ${embedded.slice(0, 16)}...`);

  if (embedded !== installed.hash) {
    console.log('note: the exe digest does not match the installed asar header; repairing from the new build.');
  }

  if (dryRun) {
    console.log('dry run: nothing written.');
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const exeBackup = path.join(backupDir, `Forma-${stamp}.exe`);
  const asarBackup = path.join(backupDir, `app-${stamp}.asar`);
  fs.copyFileSync(exe, exeBackup);
  fs.copyFileSync(asarFile, asarBackup);

  const sealed = resealExeBytes(exe, built.hash);

  const stagedAsar = asarFile + '.forma-new';
  const stagedExe = exe + '.forma-new';
  fs.copyFileSync(outAsar, stagedAsar);
  if (sealed.bytes) fs.writeFileSync(stagedExe, sealed.bytes);

  try {
    fs.renameSync(stagedAsar, asarFile);
    if (sealed.bytes) fs.renameSync(stagedExe, exe);
  } catch (error) {
    fs.copyFileSync(asarBackup, asarFile);
    fs.rmSync(stagedAsar, { force: true });
    fs.rmSync(stagedExe, { force: true });
    throw new Error(`Install failed and was rolled back: ${error.message}`);
  }

  const after = asarHeaderHash(asarFile);
  if (after.hash !== built.hash) throw new Error('The installed app.asar header changed during the copy.');
  const sealedNow = fs
    .readFileSync(exe)
    .subarray(at + ASAR_MARKER.length, at + ASAR_MARKER.length + 64)
    .toString('latin1');
  if (sealedNow !== built.hash) throw new Error('The executable was not re-sealed correctly.');

  console.log(`sealed       ${sealed.changed ? 'updated' : 'already current'}`);
  console.log(`backup       ${backupDir}`);
  console.log('done. Start Forma.exe to verify the Claude card.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
