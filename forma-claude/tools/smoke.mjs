/**
 * End-to-end proof: mint -> activate -> lease -> verify -> revoke.
 * Runs against a live server on BASE.
 *
 *   node tools/smoke.mjs
 */
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const ADMIN_PATH = process.env.ADMIN_PATH || 'ops';
const PASSWORD = process.env.ADMIN_PASSWORD || 'testpass123';
const DEVICE = 'dev-' + Math.random().toString(36).slice(2, 12);

let cookies = '';

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

const run = async () => {
  // 1. health
  const health = await call('/health');
  ok('health', health.json?.ok === true);

  // 2. login
  const login = await call(`/${ADMIN_PATH}/login`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  ok('admin login', login.status === 200 && login.json?.ok === true);
  const csrf = decodeURIComponent(cookies.split('=')[1] || '');

  // 3. mint
  const mint = await call(`/${ADMIN_PATH}/api/licenses/issue`, {
    method: 'POST',
    headers: { 'x-forma-csrf': csrf },
    body: JSON.stringify({ tier: 'standard', count: 1, batch: 'smoke' }),
  });
  ok('mint key', mint.json?.ok === true && mint.json.keys?.length === 1);
  const key = mint.json.keys[0].key;
  ok('key shape', /^FORMA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key));

  // 4. activate on a device
  const act = await call('/v1/activate', {
    method: 'POST',
    body: JSON.stringify({ key, deviceId: DEVICE }),
  });
  ok('activate', act.json?.ok === true, `tier=${act.json?.license?.tier}`);
  ok('features present', Array.isArray(act.json?.license?.features) && act.json.license.features.includes('reset'));

  // 5. same key on a different device must fail
  const wrong = await call('/v1/activate', {
    method: 'POST',
    body: JSON.stringify({ key, deviceId: 'dev-other-device-999' }),
  });
  ok('device binding enforced', wrong.json?.ok === false && wrong.json?.error === 'device_mismatch');

  // 6. lease
  const lease = await call('/v1/lease', {
    method: 'POST',
    body: JSON.stringify({ key, deviceId: DEVICE }),
  });
  ok('lease issued', lease.json?.ok === true);
  ok('lease secret present', typeof lease.json?.leaseSecret === 'string' && lease.json.leaseSecret.length > 20);
  ok('lease token shape', /^FLEASE1\./.test(lease.json?.lease || ''));

  // 6b. the sealed module must actually open, and only for this device
  ok('lease carries a sealed module', typeof lease.json?.sealedModule === 'string' && lease.json.sealedModule.length > 80);
  {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { openModule } = req('../client/main/forma-protected.cjs');
    const file = nodePath.join(os.tmpdir(), `forma-seal-${Date.now()}.fsl`);
    await fsp.writeFile(file, Buffer.from(lease.json.sealedModule, 'base64'));

    const mod = openModule({ file, leaseSecret: lease.json.leaseSecret, deviceId: DEVICE });
    ok('sealed module exports plan', typeof mod.plan === 'function');
    ok('sealed module computes a window', mod.windows([Date.now()]).length === 1);
    ok('sealed module redacts', !mod.redact('sessionKey=abc123').includes('abc123'));

    let wrongDevice = false;
    try {
      openModule({ file, leaseSecret: lease.json.leaseSecret, deviceId: 'dev-other' });
    } catch {
      wrongDevice = true;
    }
    ok('sealed module refuses another device', wrongDevice);

    let wrongSecret = false;
    try {
      openModule({ file, leaseSecret: crypto.randomBytes(32).toString('base64'), deviceId: DEVICE });
    } catch {
      wrongSecret = true;
    }
    ok('sealed module refuses another secret', wrongSecret);

    await fsp.rm(file, { force: true });
  }


  // 7. heartbeat verifies the lease
  const beat = await call('/v1/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ lease: lease.json.lease, deviceId: DEVICE }),
  });
  ok('lease verifies', beat.json?.ok === true);

  // 8. lease on the wrong device fails
  const badBeat = await call('/v1/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ lease: lease.json.lease, deviceId: 'dev-wrong' }),
  });
  ok('lease bound to device', badBeat.json?.ok === false);

  // 9. revoke, then a fresh lease must fail
  const revoke = await call(`/${ADMIN_PATH}/api/licenses/revoke`, {
    method: 'POST',
    headers: { 'x-forma-csrf': csrf },
    body: JSON.stringify({ id: act.json.license.id }),
  });
  ok('revoke', revoke.json?.ok === true);
  const afterRevoke = await call('/v1/lease', {
    method: 'POST',
    body: JSON.stringify({ key, deviceId: DEVICE }),
  });
  ok('revoked key cannot lease', afterRevoke.json?.ok === false && afterRevoke.json?.error === 'revoked');

  // 10. signed validate envelope: the shape the client actually consumes
  const mint2 = await call(`/${ADMIN_PATH}/api/licenses/issue`, {
    method: 'POST',
    headers: { 'x-forma-csrf': csrf },
    body: JSON.stringify({ tier: 'pro', count: 1, batch: 'validate' }),
  });
  const key2 = mint2.json.keys[0].key;
  const DEVICE2 = 'dev-' + Math.random().toString(36).slice(2, 12);
  const nonce = 'n' + Math.random().toString(36).slice(2, 18);
  const val = await call('/v1/validate', {
    method: 'POST',
    body: JSON.stringify({ key: key2, device: DEVICE2, nonce, appVersion: '2.0.0' }),
  });
  ok('validate returns an envelope', typeof val.json?.envelope?.payload === 'string');
  ok('validate envelope is signed', /^[A-Za-z0-9_-]{40,120}$/.test(val.json?.envelope?.signature || ''));
  const payload = JSON.parse(val.json.envelope.payload);
  ok('validate payload is active', payload.status === 'active');
  ok('validate echoes the nonce', payload.nonce === nonce);
  ok('validate binds the device', payload.device === DEVICE2);
  ok('validate grants features', Array.isArray(payload.features) && payload.features.includes('reset'));
  ok('validate sets a short window', payload.validUntil > Date.now() && payload.validUntil - payload.issuedAt <= 20 * 60_000);

  const badVal = await call('/v1/validate', {
    method: 'POST',
    body: JSON.stringify({ key: 'FORMA1.bogus.bogus', device: DEVICE2, nonce }),
  });
  ok('bogus key yields invalid', JSON.parse(badVal.json.envelope.payload).status === 'invalid');

  // 10b. the client can verify that signature with the pinned public key
  const pk = await call('/v1/public-key');
  const pub = crypto.createPublicKey(pk.json.publicKey);
  const sigOk = crypto.verify(
    null,
    Buffer.from(`FORMA-CLAUDE-LEASE-v1\n${val.json.envelope.payload}`, 'utf8'),
    pub,
    Buffer.from(val.json.envelope.signature, 'base64url'),
  );
  ok('client verifies the envelope', sigOk === true);

  const tampered = crypto.verify(
    null,
    Buffer.from(`FORMA-CLAUDE-LEASE-v1\n${val.json.envelope.payload.replace('"status":"active"', '"status":"active","x":1')}`, 'utf8'),
    pub,
    Buffer.from(val.json.envelope.signature, 'base64url'),
  );
  ok('tampered payload fails', tampered === false);

  // 11. state-changing admin call requires csrf
  const noCsrf = await call(`/${ADMIN_PATH}/api/licenses/revoke`, {
    method: 'POST',
    headers: { 'x-forma-csrf': '' },
    body: JSON.stringify({ id: 'anything' }),
  });
  ok('csrf enforced', noCsrf.status === 401);

  // 11. overview reflects the mint
  const overview = await call(`/${ADMIN_PATH}/api/overview`, {
    headers: { 'x-forma-csrf': csrf },
  });
  ok('overview', overview.json?.ok === true && overview.json.total >= 1);

  console.log('\ndone.');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
