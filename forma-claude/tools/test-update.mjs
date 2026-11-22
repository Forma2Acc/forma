/**
 * End-to-end proof of the update loop, against a live server.
 *
 *   node tools/test-update.mjs
 *
 * Uploads a fake installer, signs a release, then drives the real updater:
 * download -> SHA-256 -> bundle backup -> pending marker. Nothing is executed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { publishRelease, sha256File } from './publish-lib.mjs';

const require = createRequire(import.meta.url);
const { FormaUpdater } = require('../client/main/forma-updater.cjs');

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const ADMIN_PATH = process.env.ADMIN_PATH || 'ops';
const PASSWORD = process.env.ADMIN_PASSWORD || 'testpass123';

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed += 1;
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'forma-update-'));
const appRoot = path.join(root, 'app');
const userData = path.join(root, 'userData');
const artifact = path.join(root, 'FormaClaude-2.1.0.exe');
const originalAsar = crypto.randomBytes(4096);
const version = `2.1.${Math.floor(Math.random() * 900) + 100}`;

try {
  await fsp.mkdir(path.join(appRoot, 'resources'), { recursive: true });
  await fsp.writeFile(path.join(appRoot, 'resources', 'app.asar'), originalAsar);
  await fsp.writeFile(artifact, crypto.randomBytes(200 * 1024));

  const published = await publishRelease({
    api: BASE,
    adminPath: ADMIN_PATH,
    password: PASSWORD,
    file: artifact,
    version,
    notes: 'Test release.',
  });
  ok('release published', published.ok === true && published.version === version);
  ok('manifest names the asset', published.envelope.payload.includes(path.basename(artifact)));

  const pk = await (await fetch(`${BASE}/v1/public-key`)).json();
  const updater = new FormaUpdater({
    apiUrl: BASE,
    currentVersion: '2.0.0',
    publicKeyPem: pk.publicKey,
    userData,
    appRoot,
  });
  await updater.init();

  const result = await updater.check({ install: true });
  ok('updater finds the release', result.ok === true && result.update?.version === version);
  ok('installer downloaded', Boolean(result.file) && fs.existsSync(result.file));
  ok('checksum matches', result.file ? (await sha256File(result.file)) === published.sha256 : false);
  ok('bundle backed up', fs.existsSync(path.join(appRoot, 'resources', 'app.asar.bak')));
  ok(
    'backup is the previous bundle',
    fs.existsSync(path.join(appRoot, 'resources', 'app.asar.bak'))
      ? fs.readFileSync(path.join(appRoot, 'resources', 'app.asar.bak')).equals(originalAsar)
      : false,
  );

  const pending = JSON.parse(await fsp.readFile(path.join(userData, 'updates', 'pending.json'), 'utf8'));
  ok('pending marker written', pending.version === version && pending.sha256 === published.sha256);

  const upToDate = new FormaUpdater({
    apiUrl: BASE,
    currentVersion: version,
    publicKeyPem: pk.publicKey,
    userData,
    appRoot,
  });
  await upToDate.init();
  const second = await upToDate.check({ install: false });
  ok('same version means no update', second.ok === true && second.update === null);

  // A manifest signed by a different key must be refused.
  const wrong = crypto.generateKeyPairSync('ed25519');
  const bad = new FormaUpdater({
    apiUrl: BASE,
    currentVersion: '0.0.1',
    publicKeyPem: wrong.publicKey.export({ type: 'spki', format: 'pem' }),
    userData,
    appRoot,
  });
  await bad.init();
  const badResult = await bad.check({ install: false });
  ok(
    'foreign-signed release rejected',
    badResult.ok === false && /signature is invalid/i.test(badResult.reason || ''),
    badResult.reason || '',
  );

  // Boot guard: three failed boots roll back the bundle.
  const guard = new FormaUpdater({
    apiUrl: BASE,
    currentVersion: version,
    publicKeyPem: pk.publicKey,
    userData,
    appRoot,
  });
  await guard.init();
  await fsp.writeFile(path.join(appRoot, 'resources', 'app.asar'), Buffer.from('broken bundle'));
  let rollback = null;
  for (let i = 0; i < 4; i++) rollback = await guard.guardBoot();
  ok('failed boots trigger rollback', rollback?.rolledBack === true);
  ok(
    'rollback restored the good bundle',
    fs.readFileSync(path.join(appRoot, 'resources', 'app.asar')).equals(originalAsar),
  );
} finally {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} failed` : '\nall green');
process.exit(failed ? 1 : 0);
