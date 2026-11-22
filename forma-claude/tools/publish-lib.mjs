/**
 * Shared release publishing helper.
 *
 * Uploads an artifact, then signs a release manifest that names it. Used by
 * tools/publish-release.mjs (CLI) and tools/test-update.mjs (proof).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export async function adminSession({ api, adminPath = 'admin', password }) {
  const base = String(api).replace(/\/+$/, '');
  const res = await fetch(`${base}/${adminPath}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`admin login failed (HTTP ${res.status})`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('admin login returned no session cookie');
  const csrf = decodeURIComponent(cookie.split('=').slice(1).join('='));
  return {
    base,
    cookie,
    csrf,
    async post(route, body) {
      const out = await fetch(`${base}/${adminPath}/api/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-forma-csrf': csrf },
        body: JSON.stringify(body || {}),
      });
      const json = await out.json().catch(() => null);
      if (!out.ok) throw new Error(`${route} failed (HTTP ${out.status}) ${JSON.stringify(json)}`);
      return json;
    },
    async get(route) {
      const out = await fetch(`${base}/${adminPath}/api/${route}`, { headers: { cookie, 'x-forma-csrf': csrf } });
      const json = await out.json().catch(() => null);
      if (!out.ok) throw new Error(`${route} failed (HTTP ${out.status})`);
      return json;
    },
    async upload(file, name) {
      const stat = await fs.promises.stat(file);
      const stream = fs.createReadStream(file);
      const out = await fetch(`${base}/${adminPath}/api/releases/upload?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
          cookie,
          'x-forma-csrf': csrf,
        },
        body: stream,
        duplex: 'half',
      });
      const json = await out.json().catch(() => null);
      if (!out.ok) throw new Error(`upload failed (HTTP ${out.status}) ${JSON.stringify(json)}`);
      return json;
    },
  };
}

export async function publishRelease({
  api,
  adminPath = 'admin',
  password,
  file,
  version,
  notes = '',
  platform = 'win32',
  arch = 'x64',
  mandatory = false,
  minVersion = '0.0.0',
  assetName = null,
}) {
  if (!fs.existsSync(file)) throw new Error(`artifact not found: ${file}`);
  const name = assetName || path.basename(file);
  const localSha = await sha256File(file);
  const size = (await fs.promises.stat(file)).size;

  const session = await adminSession({ api, adminPath, password });
  const uploaded = await session.upload(file, name);
  if (uploaded.sha256 !== localSha) throw new Error('uploaded artifact does not match the local file');

  const published = await session.post('releases', {
    version,
    notes,
    mandatory,
    minVersion,
    assets: [{ platform, arch, name, sha256: localSha, size }],
  });

  return { ...published, name, sha256: localSha, size };
}
