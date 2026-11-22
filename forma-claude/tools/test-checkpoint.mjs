/**
 * Checkpoint proof. Spawns its own server instances, so it needs no setup.
 *
 *   node tools/test-checkpoint.mjs
 *
 * Proves:
 *   - a key is only issued after a completed challenge
 *   - a challenge is single-use
 *   - an installation gets its live key back instead of a dead end
 *   - the key carries a five-hour rolling window
 *   - in postback mode the return page alone issues nothing
 *   - a postback with a bad signature is refused
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(env, fn) {
  const port = 8800 + Math.floor(Math.random() * 400);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-chk-'));
  const child = spawn(process.execPath, [path.join('server', 'app.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PATH: 'ops',
      ADMIN_PASSWORD: 'testpass123',
      FORMA_DATA_DIR: dataDir,
      ...env,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  if (!up) {
    child.kill();
    throw new Error('server did not start');
  }

  try {
    return await fn(base);
  } finally {
    child.kill();
    await sleep(120);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function tokenFrom(location) {
  const c = new URL(location).searchParams.get('c');
  return c || '';
}

function keyFrom(html) {
  const m = /FORMA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(html);
  return m ? m[0] : '';
}

async function adminKeys(base) {
  const login = await fetch(`${base}/ops/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const csrf = decodeURIComponent(cookie.split('=').slice(1).join('='));
  const res = await fetch(`${base}/ops/api/licenses?batch=checkpoint`, {
    headers: { cookie, 'x-forma-csrf': csrf },
  });
  return res.json();
}

// ── direct mode ─────────────────────────────────────────────────────────────
console.log('\ndirect mode');
await withServer({ CHECKPOINT_MODE: 'direct' }, async (base) => {
  const page = await fetch(`${base}/get-key`);
  ok('key page renders', page.ok && (await page.text()).includes('Forma Claude'));

  const start = await fetch(`${base}/get-key/start?installation=inst-aaaa1111`, { redirect: 'manual' });
  const location = start.headers.get('location') || '';
  ok('start redirects to a checkpoint', start.status === 302 && location.includes('/get-key/return?c='));
  ok('challenge cookie is set', String(start.headers.get('set-cookie') || '').includes('forma_chk='));

  const token = tokenFrom(location);
  ok('token is signed', /^c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));

  const back = await fetch(`${base}/get-key/return?c=${encodeURIComponent(token)}`);
  const html = await back.text();
  const key = keyFrom(html);
  ok('return issues a key', back.status === 200 && key.startsWith('FORMA1.'));
  ok('result page names the tier', html.includes('trial'));

  const stored = await adminKeys(base);
  ok('key is recorded server-side', stored.total === 1 && stored.items[0].batch === 'checkpoint');

  const again = await fetch(`${base}/get-key/return?c=${encodeURIComponent(token)}`);
  ok('challenge is single-use', again.status === 400 && (await again.text()).includes('already claimed'));

  const reuse = await fetch(`${base}/get-key/start?installation=inst-aaaa1111`, { redirect: 'manual' });
  const reuseHtml = await reuse.text();
  ok('same installation gets its live key back', reuse.status === 200 && keyFrom(reuseHtml) === key);

  const device = 'a1b2c3d4'.repeat(8);
  const nonce = crypto.randomBytes(16).toString('hex');
  const validate = await fetch(`${base}/v1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, device, nonce, appVersion: 'test' }),
  });
  const validated = await validate.json();
  const payload = JSON.parse(validated.envelope.payload);
  ok('the key validates on first use', validate.ok && payload.status === 'active');
  ok(
    'the key window is five hours',
    Math.round((payload.licenseExpiresAt - payload.issuedAt) / 3_600_000) === 5,
    `${Math.round((payload.licenseExpiresAt - payload.issuedAt) / 3_600_000)}h`,
  );

  const other = await fetch(`${base}/get-key/start?installation=inst-bbbb2222`, { redirect: 'manual' });
  ok('a different installation can start', other.status === 302);

  const forged = await fetch(`${base}/get-key/return?c=c1.eyJpZCI6IngiLCJleHAiOjk5OTk5OTk5OTk5OTl9.AAAA`);
  ok('a forged token is refused', forged.status === 400);
});

// ── postback mode ───────────────────────────────────────────────────────────
console.log('\npostback mode');
const POSTBACK_SECRET = 'postback-secret-for-test';

await withServer(
  {
    CHECKPOINT_MODE: 'postback',
    LINKVERTISE_URL: 'https://direct-link.net/0000000/postback',
    LINKVERTISE_POSTBACK_SECRET: POSTBACK_SECRET,
  },
  async (base) => {
    const start = await fetch(`${base}/get-key/start?installation=inst-cccc3333`, { redirect: 'manual' });
    const cookie = String(start.headers.get('set-cookie') || '').split(';')[0];
    const token = decodeURIComponent(cookie.split('=').slice(1).join('='));
    ok('postback mode starts a challenge', Boolean(token));

    const early = await fetch(`${base}/get-key/return?c=${encodeURIComponent(token)}`);
    ok(
      'return without a postback issues nothing',
      early.status === 400 && (await early.text()).includes('not completed'),
    );

    const bad = await fetch(`${base}/v1/linkvertise/postback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ c: token, sig: 'nope' }),
    });
    ok('bad postback signature refused', bad.status === 403);

    const sig = crypto.createHmac('sha256', POSTBACK_SECRET).update(token).digest('base64url');
    const good = await fetch(`${base}/v1/linkvertise/postback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ c: token, sig }),
    });
    ok('valid postback accepted', good.status === 200);

    const done = await fetch(`${base}/get-key/return?c=${encodeURIComponent(token)}`);
    ok('key is issued after the postback', done.status === 200 && keyFrom(await done.text()).startsWith('FORMA1.'));

    const replay = await fetch(`${base}/get-key/return?c=${encodeURIComponent(token)}`);
    ok('postback challenge is single-use', replay.status === 400);
  },
);

// ── linkvertise mode ────────────────────────────────────────────────────────
// A tiny stand-in for Linkvertise's anti-bypassing endpoint. It answers true
// only for one known hash, which is exactly the contract the real endpoint has.
console.log('\nlinkvertise mode');

const GOOD_HASH = 'a'.repeat(64);
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const hash = url.searchParams.get('hash') || '';
  const token = url.searchParams.get('token') || '';
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(token === 'lv-test-token' && hash === GOOD_HASH ? 'true' : 'false');
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;

await withServer(
  {
    CHECKPOINT_MODE: 'linkvertise',
    LINKVERTISE_URL: 'https://direct-link.net/0000000/test',
    LINKVERTISE_TOKEN: 'lv-test-token',
    LINKVERTISE_VERIFY_URL: `http://127.0.0.1:${mockPort}/api/v1/anti_bypassing`,
  },
  async (base) => {
    const start = await fetch(`${base}/get-key/start?installation=inst-dddd4444`, {
      redirect: 'manual',
    });
    ok(
      'linkvertise mode redirects to the ad link',
      start.status === 302 && (start.headers.get('location') || '').includes('direct-link.net'),
    );

    const cookie = String(start.headers.get('set-cookie') || '').split(';')[0];
    const token = decodeURIComponent(cookie.split('=').slice(1).join('='));

    const noProof = await fetch(`${base}/get-key/return`, { headers: { cookie } });
    ok('return without a hash issues nothing', noProof.status === 400);

    const badProof = await fetch(`${base}/get-key/return?hash=${'b'.repeat(64)}`, {
      headers: { cookie },
    });
    ok('a hash the provider rejects issues nothing', badProof.status === 400);

    const good = await fetch(`${base}/get-key/return?hash=${GOOD_HASH}`, { headers: { cookie } });
    ok('a provider-confirmed hash issues a key', good.status === 200 && keyFrom(await good.text()).startsWith('FORMA1.'));

    const replay = await fetch(`${base}/get-key/return?hash=${GOOD_HASH}`, { headers: { cookie } });
    ok('the challenge cannot be replayed', replay.status === 400);

    // The paste path: the user lands on another page, copies its address, and
    // pastes it into the key page. Same verification, same single use.
    const second = await fetch(`${base}/get-key/start?installation=inst-eeee5555`, {
      redirect: 'manual',
    });
    const secondCookie = String(second.headers.get('set-cookie') || '').split(';')[0];
    const claimed = await fetch(`${base}/get-key/claim?hash=${GOOD_HASH}`, {
      headers: { cookie: secondCookie },
    });
    ok(
      'a pasted landed address issues a key',
      claimed.status === 200 && keyFrom(await claimed.text()).startsWith('FORMA1.'),
    );

    const claimedAgain = await fetch(`${base}/get-key/claim?hash=${GOOD_HASH}`, {
      headers: { cookie: secondCookie },
    });
    ok('the pasted challenge is single-use', claimedAgain.status === 400);

    const noSession = await fetch(`${base}/get-key/claim?hash=${GOOD_HASH}`);
    ok('claim without a checkpoint session is refused', noSession.status === 400);

    ok('the token was signed', /^c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  },
);

mock.close();

console.log(failed ? `\n${failed} failed` : '\nall green');
process.exit(failed ? 1 : 0);
