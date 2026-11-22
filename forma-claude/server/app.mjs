import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLicenseService, createFileStore } from './license-service.mjs';
import { createCheckpointService } from './checkpoint.mjs';
import { keyPage, resultPage, errorPage, notFoundPage, existingPage } from './pages.mjs';

/**
 * Forma Claude — core server.
 *
 * Routes
 *   GET  /health
 *   GET  /get-key                 license key page (browser)
 *   POST /v1/activate             { key, deviceId } -> license
 *   POST /v1/lease                { key, deviceId } -> lease + leaseSecret + sealedModule
 *   POST /v1/heartbeat            { lease } -> ok
 *   GET  /v1/releases/latest      signed release envelope
 *
 *   Admin (cookie session + CSRF header)
 *   POST /login
 *   GET  /api/overview
 *   GET  /api/licenses
 *   POST /api/licenses/issue      { tier, count, batch }
 *   POST /api/licenses/revoke     { id }
 *   POST /api/licenses/unrevoke   { id }
 *   POST /api/licenses/unbind     { id }
 *   POST /api/licenses/extend     { id, hours }
 *   POST /api/licenses/delete     { id }
 *   GET  /api/licenses/export     ?batch=
 *   GET  /api/events
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PATH = (process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'forma_admin';
const MAX_BODY = 256 * 1024;

// One persistent directory holds the license database, the signing key and the
// release assets. On Railway that is a mounted volume, so a redeploy does not
// invalidate every issued key. Without FORMA_DATA_DIR the repo layout is used.
const PERSIST = process.env.FORMA_DATA_DIR ? path.resolve(process.env.FORMA_DATA_DIR) : '';
const DATA_DIR = PERSIST ? path.join(PERSIST, 'data') : path.join(ROOT, '.data');
const KEY_DIR = PERSIST ? path.join(PERSIST, 'keys') : path.join(ROOT, '.keys');
const ASSET_DIR = PERSIST ? path.join(PERSIST, 'releases') : path.join(ROOT, 'releases');

const store = createFileStore(DATA_DIR);
const RELEASES_DIR = ASSET_DIR;
const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;

let moduleSource = null;
const modulePath = path.join(ROOT, 'protected', 'module.cjs');
if (fs.existsSync(modulePath)) moduleSource = fs.readFileSync(modulePath, 'utf8');

const license = createLicenseService({
  store,
  keyDir: KEY_DIR,
  moduleSource,
});

// ── checkpoint ───────────────────────────────────────────────────────────────
// A key is only minted after a signed, single-use, rate-limited challenge.
const CHECKPOINT_MODE =
  process.env.CHECKPOINT_MODE || (process.env.LINKVERTISE_URL ? 'linkvertise' : 'direct');

const checkpoints = createCheckpointService({
  store,
  secret: process.env.CHECKPOINT_SECRET || SESSION_SECRET,
  mode: CHECKPOINT_MODE,
  linkvertiseUrl: process.env.LINKVERTISE_URL || '',
  linkvertiseToken: process.env.LINKVERTISE_API_TOKEN || process.env.LINKVERTISE_TOKEN || '',
  postbackSecret: process.env.LINKVERTISE_POSTBACK_SECRET || '',
  tier: process.env.CHECKPOINT_TIER || 'trial',
  cooldownMs: Number(process.env.CHECKPOINT_COOLDOWN_SECONDS || 60) * 1_000,
  ipLimitPerHour: Number(process.env.CHECKPOINT_IP_LIMIT || 6),
  origin: process.env.PUBLIC_ORIGIN || '',
  verifyUrl: process.env.LINKVERTISE_VERIFY_URL || undefined,
});

const CHECKPOINT_COOKIE = 'forma_chk';
const CHECKPOINT_COOKIE_PATH = '/get-key';

const events = [];function record(kind, detail = {}) {
  const row = { at: new Date().toISOString(), kind, ...detail };
  events.unshift(row);
  if (events.length > 2000) events.length = 2000;
  return row;
}

// ── http helpers ─────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** Stream a raw request body to disk, hashing as it goes. */
async function streamToFile(req, dest, maxBytes) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(dest);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('too_large');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => {
      out.end(resolve);
      out.once('error', reject);
    });
  } catch (err) {
    out.destroy();
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  return { size, sha256: hash.digest('hex') };
}

function safeAssetName(name) {
  const value = String(name || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) return null;
  if (value.includes('..')) return null;
  return value;
}

function parseCookies(header) {  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signSession(expiresAt) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(String(expiresAt)).digest('base64url');
  return `${expiresAt}.${mac}`;
}

function verifySession(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!verifySession(cookies[SESSION_COOKIE])) return false;
  // CSRF: every state-changing request must echo the session token in a header.
  if (req.method !== 'GET' && req.headers['x-forma-csrf'] !== cookies[SESSION_COOKIE]) return false;
  return true;
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── pages ────────────────────────────────────────────────────────────────────

const KEY_PAGE = keyPage({ checkpoint: CHECKPOINT_MODE });
const RESULT_PAGE = resultPage;
const ERROR_PAGE = errorPage;
const EXISTING_PAGE = existingPage;

/** Newest release asset URL, used by every public download button. */
function latestDownloadUrl() {
  try {
    const envelope = store.get('config', 'release');
    if (!envelope?.payload) return '';
    const payload = JSON.parse(envelope.payload);
    const asset = (payload.assets || []).find((a) => /\.(zip|exe)$/i.test(String(a.url || '')));
    return asset?.url || '';
  } catch {
    return '';
  }
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forma — admin</title>
<style>
:root{--bg:#0a0a0b;--fg:#ecebe8;--mut:#8a8886;--line:rgba(236,235,232,.14)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh}
form{width:300px;border:1px solid var(--line);border-radius:12px;padding:28px}
h1{margin:0 0 18px;font-size:15px;font-weight:600}
input{width:100%;background:#111;border:1px solid var(--line);border-radius:7px;padding:10px;color:var(--fg);
font:inherit;margin-bottom:12px}
button{width:100%;background:var(--fg);color:#111;border:0;border-radius:7px;padding:10px;font-weight:600;cursor:pointer}
.err{color:#d1685c;font-size:12.5px;min-height:18px;margin-top:8px}
</style></head><body>
<form id="f"><h1>Forma admin</h1>
<input id="p" type="password" placeholder="Password" autocomplete="current-password" autofocus>
<button type="submit">Sign in</button>
<div class="err" id="e"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/${ADMIN_PATH}/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('p').value }),
  });
  if (res.ok) location.href = '/${ADMIN_PATH}/';
  else document.getElementById('e').textContent = 'Wrong password.';
});
</script></body></html>`;

// ── router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // ── public ──────────────────────────────────────────────────────────────
    if (route === '/health') return send(res, 200, { ok: true, service: 'forma-claude', at: new Date().toISOString() });

    if ((route === '/download' || route === '/download/latest') && req.method === 'GET') {
      const target = latestDownloadUrl();
      if (!target) return send(res, 404, ERROR_PAGE('No release is published yet.', 'Try again in a few minutes.'));
      return send(res, 302, '', { location: target });
    }

    if (route === '/get-key' && req.method === 'GET') {
      // A returning browser with a live key sees that key, not another ad page.
      const cookies = parseCookies(req.headers.cookie);
      const installation = decodeURIComponent(cookies.forma_inst || '');
      const live = installation ? checkpoints.peek(installation) : null;
      if (live) return send(res, 200, EXISTING_PAGE(live.key, live));
      return send(res, 200, KEY_PAGE);
    }

    // ── checkpoint ──────────────────────────────────────────────────────────
    if (route === '/get-key/start' && req.method === 'GET') {
      const cookies = parseCookies(req.headers.cookie);
      const installation =
        url.searchParams.get('installation') || decodeURIComponent(cookies.forma_inst || '') || '';
      const started = await checkpoints.start({
        installation,
        ip: req.socket.remoteAddress || '',
        ua: req.headers['user-agent'] || '',
        origin: process.env.PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost'}`,
      });

      if (!started.ok) {
        record('checkpoint.blocked', { error: started.error });
        const hint =
          started.error === 'cooldown'
            ? `Try again after ${new Date(started.retryAt).toUTCString()}.`
            : started.error === 'rate_limited'
              ? 'Too many attempts from this network.'
              : '';
        return send(res, 429, ERROR_PAGE(started.message || 'Not available.', hint));
      }

      if (started.existing) {
        // The installation already has a live key. Show it again instead of
        // sending the user through a checkpoint they do not need.
        record('checkpoint.existing', { tier: started.tier || null });
        return send(res, 200, EXISTING_PAGE(started.key, started));
      }

      record('checkpoint.started', { mode: started.mode, provider: started.provider });
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      const cookiesOut = [
        `${CHECKPOINT_COOKIE}=${encodeURIComponent(started.token)}; Path=${CHECKPOINT_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=1200${secure}`,
      ];
      if (installation) {
        cookiesOut.push(
          `forma_inst=${encodeURIComponent(installation)}; Path=/get-key; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
        );
      }
      return send(res, 302, '', { location: started.url, 'set-cookie': cookiesOut });
    }

    if (route === '/get-key/return' && req.method === 'GET') {
      const cookies = parseCookies(req.headers.cookie);
      const token = url.searchParams.get('c') || decodeURIComponent(cookies[CHECKPOINT_COOKIE] || '');
      // Linkvertise appends ?hash=… to the destination once the ad is done.
      const hash =
        url.searchParams.get('hash') ||
        url.searchParams.get('h') ||
        url.searchParams.get('lv_hash') ||
        '';
      const done = await checkpoints.complete({
        token,
        hash,
        ip: req.socket.remoteAddress || '',
      });

      if (!done.ok) {
        record('checkpoint.incomplete', { error: done.error, state: done.state || null });
        const hint =
          done.error === 'not_verified'
            ? 'Complete the checkpoint page, then open the link it sends you back to.'
            : done.error === 'expired'
              ? 'Checkpoints last 20 minutes.'
              : '';
        return send(res, 400, ERROR_PAGE(done.message || 'Checkpoint not completed.', hint));
      }

      const [minted] = license.mint({ tier: done.checkpoint.tier, batch: 'checkpoint' });
      checkpoints.attachKey(done.checkpoint.id, minted.id);
      record('key.issued', {
        tier: done.checkpoint.tier,
        batch: 'checkpoint',
        install: done.checkpoint.installation || null,
      });
      return send(res, 200, RESULT_PAGE(minted.key, done.checkpoint));
    }

    if (route === '/get-key/claim' && req.method === 'GET') {
      const cookies = parseCookies(req.headers.cookie);
      const token = decodeURIComponent(cookies[CHECKPOINT_COOKIE] || '');
      let hash = url.searchParams.get('hash') || '';
      const landed = url.searchParams.get('u') || '';
      if (!hash && landed) {
        try {
          hash = new URL(landed).searchParams.get('hash') || '';
        } catch {}
      }

      if (!token) {
        return send(
          res,
          400,
          ERROR_PAGE(
            'This checkpoint session has expired.',
            'Start again from the key page. Keep the same browser open until the key appears.',
          ),
        );
      }

      const done = await checkpoints.complete({ token, hash, ip: req.socket.remoteAddress || '' });
      if (!done.ok) {
        record('checkpoint.claim_failed', { error: done.error, state: done.state || null });
        const hint =
          done.state === 'missing_proof' || done.error === 'not_verified'
            ? 'Paste the full address you landed on, including the ?hash= part.'
            : done.error === 'expired'
              ? 'Checkpoints last 20 minutes. Start a new one.'
              : '';
        return send(res, 400, ERROR_PAGE(done.message || 'Checkpoint not verified.', hint));
      }

      const [minted] = license.mint({ tier: done.checkpoint.tier, batch: 'checkpoint' });
      checkpoints.attachKey(done.checkpoint.id, minted.id);
      record('key.issued', {
        tier: done.checkpoint.tier,
        batch: 'checkpoint',
        install: done.checkpoint.installation || null,
        via: 'claim',
      });
      return send(res, 200, RESULT_PAGE(minted.key, done.checkpoint));
    }

    // Linkvertise postback. Only this can mark a challenge complete in
    // `postback` mode; the return page alone is not enough there.
    if (route === '/v1/linkvertise/postback' && req.method === 'POST') {
      const body = await readBody(req);
      const out = checkpoints.postback({
        token: body.c || body.token || url.searchParams.get('c') || '',
        signature: body.sig || body.signature || url.searchParams.get('sig') || '',
        ip: req.socket.remoteAddress || '',
      });
      record('checkpoint.postback', { ok: out.ok, error: out.error || null });
      return send(res, out.ok ? 200 : 403, out);
    }

    if (route === '/v1/validate' && req.method === 'POST') {
      const body = await readBody(req);
      const result = license.validate({
        key: body.key,
        device: body.device,
        nonce: body.nonce,
        appVersion: body.appVersion,
      });
      return send(res, 200, result);
    }

    if (route.startsWith('/downloads/') && req.method === 'GET') {
      const name = safeAssetName(route.slice('/downloads/'.length));
      if (!name) return send(res, 400, { ok: false, error: 'bad_name' });
      const file = path.join(RELEASES_DIR, name);
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: 'not_found' });
      const stat = await fs.promises.stat(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (route === '/v1/activate' && req.method === 'POST') {
      const body = await readBody(req);
      const result = license.activate({
        key: body.key,
        deviceId: body.deviceId,
        appVersion: body.appVersion,
        platform: body.platform,
      });
      if (result.ok) record('license.activated', { id: result.license.id, device: String(body.deviceId).slice(0, 8) });
      return send(res, result.ok ? 200 : 403, result);
    }

    if (route === '/v1/lease' && req.method === 'POST') {
      const body = await readBody(req);
      const result = license.lease({ key: body.key, deviceId: body.deviceId });
      if (result.ok) record('lease.issued', { id: result.payload.lid });
      return send(res, result.ok ? 200 : 403, result);
    }

    if (route === '/v1/heartbeat' && req.method === 'POST') {
      const body = await readBody(req);
      const check = license.verifyLease(body.lease, { deviceId: body.deviceId });
      return send(res, check.ok ? 200 : 403, check);
    }

    if (route === '/v1/releases/latest' && req.method === 'GET') {
      const envelope = store.get('config', 'release') || null;
      if (!envelope) return send(res, 404, { ok: false, error: 'no_release' });
      return send(res, 200, { ok: true, envelope });
    }

    if (route === '/v1/public-key' && req.method === 'GET') {
      return send(res, 200, { publicKey: license.publicKeyPem });
    }

    // ── admin ───────────────────────────────────────────────────────────────
    if (route === `/${ADMIN_PATH}/login` && req.method === 'POST') {
      const body = await readBody(req);
      if (!passwordMatches(body.password)) {
        record('admin.login.failed', { ip: req.socket.remoteAddress });
        return send(res, 401, { ok: false, error: 'bad_credentials' });
      }
      const token = signSession(Date.now() + SESSION_TTL_MS);
      record('admin.login', { ip: req.socket.remoteAddress });
      return send(res, 200, { ok: true }, {
        'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
    }

    if (route === `/${ADMIN_PATH}` || route === `/${ADMIN_PATH}/`) {
      if (!verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE])) {
        return send(res, 200, LOGIN_PAGE);
      }
      const file = path.join(ROOT, 'admin', 'index.html');
      if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file, 'utf8'));
      return send(res, 200, '<h1>Admin UI missing</h1><p>admin/index.html not found.</p>');
    }

    if (route.startsWith(`/${ADMIN_PATH}/api/`)) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
      const action = route.slice(`/${ADMIN_PATH}/api/`.length);

      if (action === 'overview' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...license.overview(), tiers: license.tiers, events: events.slice(0, 40) });
      }
      if (action === 'checkpoints' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...checkpoints.stats() });
      }
      if (action === 'licenses' && req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          ...license.list({
            status: url.searchParams.get('status') || undefined,
            batch: url.searchParams.get('batch') || undefined,
            limit: Number(url.searchParams.get('limit') || 200),
            offset: Number(url.searchParams.get('offset') || 0),
          }),
        });
      }
      if (action === 'licenses/issue' && req.method === 'POST') {
        const body = await readBody(req);
        const keys = license.mint({
          tier: body.tier || 'standard',
          count: Math.min(Number(body.count) || 1, 500),
          batch: body.batch || `batch-${Date.now()}`,
        });
        record('keys.minted', { count: keys.length, tier: body.tier });
        return send(res, 200, { ok: true, keys });
      }
      if (action === 'licenses/revoke' && req.method === 'POST') {
        const body = await readBody(req);
        const out = license.revoke(body.id, body.reason);
        record('license.revoked', { id: body.id });
        return send(res, 200, out);
      }
      if (action === 'licenses/unrevoke' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, license.unrevoke(body.id));
      }
      if (action === 'licenses/unbind' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, license.unbind(body.id));
      }
      if (action === 'licenses/extend' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, license.extend(body.id, body.hours || 24));
      }
      if (action === 'licenses/delete' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, license.remove(body.id));
      }
      if (action === 'licenses/export' && req.method === 'GET') {
        const batch = url.searchParams.get('batch') || '';
        return send(res, 200, { ok: true, batch, keys: license.exportBatch(batch).split('\n').filter(Boolean) });
      }
      if (action === 'events' && req.method === 'GET') {
        return send(res, 200, { ok: true, events: events.slice(0, 200) });
      }
      if (action === 'releases' && req.method === 'GET') {
        return send(res, 200, { ok: true, envelope: store.get('config', 'release') || null });
      }
      if (action === 'releases/upload' && req.method === 'POST') {
        const name = safeAssetName(url.searchParams.get('name'));
        if (!name) return send(res, 400, { ok: false, error: 'bad_name' });
        const dest = path.join(RELEASES_DIR, name);
        try {
          const out = await streamToFile(req, dest, MAX_UPLOAD_BYTES);
          record('release.uploaded', { name, bytes: out.size });
          return send(res, 200, { ok: true, name, ...out });
        } catch (err) {
          const tooLarge = String(err?.message) === 'too_large';
          return send(res, tooLarge ? 413 : 500, { ok: false, error: tooLarge ? 'too_large' : 'upload_failed' });
        }
      }
      if (action === 'releases' && req.method === 'POST') {
        const body = await readBody(req);
        const version = String(body.version || '').trim();
        if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
          return send(res, 400, { ok: false, error: 'bad_version' });
        }
        const assets = Array.isArray(body.assets) ? body.assets : [];
        if (!assets.length) return send(res, 400, { ok: false, error: 'no_assets' });
        const origin = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
        const clean = [];
        for (const a of assets) {
          const name = safeAssetName(a.name);
          if (!name) return send(res, 400, { ok: false, error: 'bad_asset' });
          if (!/^[a-f0-9]{64}$/i.test(String(a.sha256 || ''))) {
            return send(res, 400, { ok: false, error: 'bad_sha256' });
          }
          if (!fs.existsSync(path.join(RELEASES_DIR, name))) {
            return send(res, 400, { ok: false, error: `missing_asset:${name}` });
          }
          clean.push({
            platform: String(a.platform || 'win32'),
            arch: String(a.arch || 'x64'),
            url: `${origin}/downloads/${name}`,
            sha256: String(a.sha256).toLowerCase(),
            size: Number(a.size) || 0,
          });
        }
        const envelope = license.signRelease({
          v: 1,
          version,
          notes: String(body.notes || '').slice(0, 8000),
          mandatory: Boolean(body.mandatory),
          minVersion: String(body.minVersion || '0.0.0'),
          publishedAt: Date.now(),
          assets: clean,
        });
        record('release.published', { version, assets: clean.length });
        return send(res, 200, { ok: true, version, envelope });
      }
      return send(res, 404, { ok: false, error: 'unknown_action' });
    }

    if (route === '/' && req.method === 'GET') {
      return send(res, 302, '', { location: '/get-key' });
    }

    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      return send(res, 404, notFoundPage());
    }

    return send(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    record('error', { route, message: String(err?.message || err) });
    return send(res, 500, { ok: false, error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(`forma-claude core on :${PORT}  admin=/ ${ADMIN_PATH}`);
  console.log(`license public key:\n${license.publicKeyPem}`);
});
