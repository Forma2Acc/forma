'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

function windowsUpdateCommand(installer,sha256,launcher,args=['--forma-apply-update']) {
  const q=v=>"'"+String(v).replace(/'/g,"''")+"'";
  if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid installer digest.');
  const script=["$ErrorActionPreference='Stop'",'$installer='+q(installer),'$launcher='+q(launcher),
    '$hash=[Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($installer)',
    "try { $digest=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $hash.Dispose() }",
    'if ($digest -ne '+q(sha256)+') { exit 2 }',
    "$created=$false; $mtx=[Threading.Mutex]::new($false,'Local\\FormaAutoUpdaterMutex',[ref]$created)",
    'if (-not $mtx.WaitOne(0)) { $mtx.Dispose(); exit 0 }',
    'try {',
    "  $isFormaLauncher = [IO.Path]::GetFileName($launcher) -ieq 'Forma.exe'",
    '  if ($isFormaLauncher) {',
    "    for ($i=0; $i -lt 30; $i++) { $p = Get-Process -Name 'Forma','Qwen' -ErrorAction SilentlyContinue; if (-not $p) { break }; Start-Sleep -Milliseconds 200 }",
    "    Get-Process -Name 'Forma','Qwen','forma-core' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    "    for ($i=0; $i -lt 30; $i++) { $p = Get-Process -Name 'Forma','Qwen','forma-core' -ErrorAction SilentlyContinue; if (-not $p) { break }; Stop-Process -Name 'Forma','Qwen','forma-core' -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 200 }",
    '    Start-Sleep -Milliseconds 600',
    '  }',
    '  $code = 1',
    '  for ($try=0; $try -lt 2; $try++) {',
    "    $start=[Diagnostics.ProcessStartInfo]::new($installer,'/S'); $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.WindowStyle='Hidden'",
    '    $setup=[Diagnostics.Process]::Start($start); $setup.WaitForExit()',
    '    $code = $setup.ExitCode',
    '    if ($code -eq 0) { break }',
    "    if ($isFormaLauncher) { Get-Process -Name 'Forma','Qwen','forma-core' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }",
    '    Start-Sleep -Milliseconds 1500',
    '  }',
    '  if ($code -ne 0) { exit $code }',
    '  if ($isFormaLauncher) {',
    '    Start-Sleep -Milliseconds 300',
    '    if (Test-Path $launcher) {',
    '      $launch=[Diagnostics.ProcessStartInfo]::new($launcher,'+q(args.join(' '))+')',
    '      $launch.UseShellExecute=$true; $launch.WindowStyle=[Diagnostics.ProcessWindowStyle]::Normal',
    '      $launch.WorkingDirectory=[IO.Path]::GetDirectoryName($launcher)',
    '      [Diagnostics.Process]::Start($launch) | Out-Null',
    '    }',
    '  } else {',
    '    $launch=[Diagnostics.ProcessStartInfo]::new($launcher,'+q(args.join(' '))+"); $launch.UseShellExecute=$false; $launch.CreateNoWindow=$true; $launch.WindowStyle='Hidden'",
    '    [Diagnostics.Process]::Start($launch) | Out-Null',
    '  }',
    '} finally {',
    '  try { $mtx.ReleaseMutex() } catch {}',
    '  $mtx.Dispose()',
    '}'].join('\n');
  return Buffer.from(script,'utf16le').toString('base64');
}

function version(v) {
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) throw Error('Invalid version.');
  return v.split('.').map(Number);
}

function newer(a, b) {
  const x = version(a),
    y = version(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

const INSTALLER_NAME_RE = /^Forma-(\d+\.\d+\.\d+)\.(exe|AppImage|tar\.gz)$/;
const PART_NAME_RE = /^Forma-.*\.(?:exe|AppImage|tar\.gz)(?:\.\d+)?\.part$/;

async function pruneUpdateCache(root, { keepFile = null, keepLatest = 2, partMaxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const summary = { removed: [], kept: [], freedBytes: 0 };
  if (!root) return summary;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return summary;
  }
  const keepResolved = keepFile ? path.resolve(keepFile) : null;
  const installers = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(root, entry.name);
    if (PART_NAME_RE.test(entry.name)) {
      try {
        const st = await fs.stat(fullPath);
        if (now - st.mtimeMs >= partMaxAgeMs) {
          await fs.rm(fullPath, { force: true });
          summary.removed.push(entry.name);
          summary.freedBytes += st.size;
        } else {
          summary.kept.push(entry.name);
        }
      } catch {}
      continue;
    }
    const m = entry.name.match(INSTALLER_NAME_RE);
    if (m) {
      installers.push({ name: entry.name, fullPath, ver: m[1] });
    }
  }
  installers.sort((a, b) => (newer(a.ver, b.ver) ? -1 : newer(b.ver, a.ver) ? 1 : 0));
  const keepCount = Math.max(1, keepLatest);
  const keptSet = new Set();
  for (const item of installers) {
    if (keepResolved && path.resolve(item.fullPath) === keepResolved) {
      keptSet.add(item.fullPath);
    }
  }
  for (const item of installers) {
    if (keptSet.size >= keepCount) break;
    keptSet.add(item.fullPath);
  }
  for (const item of installers) {
    if (keptSet.has(item.fullPath)) {
      summary.kept.push(item.name);
      continue;
    }
    try {
      const st = await fs.stat(item.fullPath);
      await fs.rm(item.fullPath, { force: true });
      summary.removed.push(item.name);
      summary.freedBytes += st.size;
    } catch {}
  }
  return summary;
}

function verifyRelease(envelope, config, current) {
  if (
    typeof envelope?.payload !== 'string' ||
    envelope.payload.length > 12000 ||
    typeof envelope.signature !== 'string' ||
    !crypto.verify(null, Buffer.from('FORMA-UPDATE-v1\n' + envelope.payload), config.updatePublicKey, Buffer.from(envelope.signature, 'base64url'))
  ) {
    throw Error('Invalid update signature.');
  }
  const m = JSON.parse(envelope.payload);
  version(m.version);
  const u = new URL(m.url),
    prefixes = [
      `/${config.github.owner}/${config.github.repo}/releases/download/v${m.version}/`,
      `/${config.github.owner}/${config.github.repo}/releases/download/forma-launcher-v${m.version}/`,
    ];
  const aud = m.aud;
  const linuxOk = aud === 'forma-linux-x64' && (u.pathname.endsWith('.AppImage') || u.pathname.endsWith('.tar.gz'));
  const winOk = aud === 'forma-windows-x64' && u.pathname.endsWith('.exe');
  if (
    m.v !== 1 ||
    (!winOk && !linuxOk) ||
    u.protocol !== 'https:' ||
    u.hostname !== 'github.com' ||
    !prefixes.some((p) => u.pathname.startsWith(p)) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes < 1024 ||
    m.bytes > 600 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.publishedAt) ||
    m.publishedAt > Date.now() + 300000
  ) {
    throw Error('Invalid update metadata.');
  }
  const samePlatform = process.platform === 'linux' ? aud === 'forma-linux-x64' : aud === 'forma-windows-x64';
  const audAllowed = !config.updateAudience || aud === config.updateAudience || aud === 'forma-windows-x64';
  return {
    ...m,
    mandatory: !!(envelope.mandatory ?? m.mandatory),
    notes: String(envelope.notes || m.notes || '').slice(0, 1500),
    available: samePlatform && audAllowed && newer(m.version, current),
  };
}

class SignedUpdater extends EventEmitter {
  constructor({ app, config, root, fetchImpl = globalThis.fetch, restart = null }) {
    super();
    this.app = app;
    this.restart = restart;
    this.config = config;
    this.root = root;
    this.fetch = fetchImpl;
    this.value = {
      status: 'idle',
      message: 'Not checked yet',
      currentVersion: app?.getVersion?.() || '1.0.0',
      version: null,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      notes: '',
      mandatory: false,
      sha256: null,
    };
    this.pending = null;
    this.file = null;
  }

  state() {
    return { ...this.value };
  }

  set(v) {
    this.value = { ...this.value, ...v };
    this.emit('change', this.state());
    return this.state();
  }

  async fetchBackendEnvelope() {
    if (!this.config.apiUrl) return null;
    let u;
    try {
      u = new URL('/v1/releases/latest', this.config.apiUrl);
      if (u.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    try {
      const r = await this.fetch(u.href, { headers: { Accept: 'application/json', 'User-Agent': 'Forma-Launcher' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > 20000) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async fetchGithubEnvelope() {
    if (!this.config?.github?.owner || !this.config?.github?.repo) return null;
    try {
      const { owner, repo } = this.config.github;
      const readReleaseManifest = async (release) => {
        if (!release || release.draft || release.prerelease) return null;
        const asset = release.assets?.find((x) => x.name === 'forma-update.json');
        if (!asset) return null;
        const assetUrl = new URL(asset.browser_download_url);
        if (assetUrl.origin !== 'https://github.com' || !assetUrl.pathname.startsWith(`/${owner}/${repo}/releases/download/`)) {
          return null;
        }
        const r = await this.fetch(assetUrl, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) return null;
        const text = await r.text();
        if (text.length > 20000) return null;
        const envelope = JSON.parse(text);
        if (release.body && !envelope.notes) envelope.notes = String(release.body).slice(0, 1500);
        return envelope;
      };

      const response = await this.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Forma-Launcher' },
        signal: AbortSignal.timeout(12000),
      }).catch(() => null);
      if (response?.ok) {
        const latestEnv = await readReleaseManifest(await response.json());
        if (latestEnv) return latestEnv;
      }

      const listRes = await this.fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=15`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Forma-Launcher' },
        signal: AbortSignal.timeout(12000),
      }).catch(() => null);
      if (!listRes?.ok) return null;
      const list = await listRes.json();
      const cand = (Array.isArray(list) ? list : []).find(
        (rel) =>
          !rel.draft &&
          !rel.prerelease &&
          !String(rel.tag_name || '').startsWith('forma-code-') &&
          rel.assets?.some((x) => x.name === 'forma-update.json'),
      );
      return await readReleaseManifest(cand);
    } catch {
      return null;
    }
  }

  async check({ autoDownload = true } = {}) {
    if (this.pending) return this.pending;
    if (['ready','downloading','verifying'].includes(this.value.status)) return this.state();
    this.pending = this._check(autoDownload);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async _check(autoDownload) {
    this.set({ status: 'checking', message: 'Analyzing GitHub & Forma release channels…', checkedAt: Date.now() });
    try {
      const current = this.app.getVersion();
      const [backendEnv, githubEnv] = await Promise.all([
        this.fetchBackendEnvelope().catch(() => null),
        this.fetchGithubEnvelope().catch(() => null),
      ]);
      const candidates = [];
      let lastVerifyError = null;
      for (const [source, env] of [['backend', backendEnv], ['github', githubEnv]]) {
        if (!env) continue;
        try {
          const verified = verifyRelease(env, this.config, current);
          candidates.push({ source, manifest: verified });
        } catch (err) {
          lastVerifyError = err;
        }
      }
      if (!candidates.length) {
        if (lastVerifyError) throw lastVerifyError;
        return this.set({
          status: 'current',
          message: 'Forma is up to date.',
          version: current,
          mandatory: false,
          notes: '',
        });
      }
      candidates.sort((a, b) => (newer(b.manifest.version, a.manifest.version) ? 1 : newer(a.manifest.version, b.manifest.version) ? -1 : 0));
      const winner = candidates.find((c) => c.manifest.available) || candidates[0];
      const manifest = winner.manifest;
      if (!manifest.available) {
        return this.set({
          status: 'current',
          message: 'Forma is up to date.',
          version: current,
          mandatory: false,
          notes: '',
        });
      }
      this.manifest = manifest;
      if (!autoDownload) {
        return this.set({
          status: 'available',
          message: `Forma ${manifest.version} (${winner.source}) is ready to download.`,
          version: manifest.version,
          totalBytes: manifest.bytes,
          downloadedBytes: 0,
          progress: 0,
          mandatory: !!manifest.mandatory,
          notes: manifest.notes || '',
          sha256: manifest.sha256,
        });
      }
      return this.download();
    } catch (e) {
      return this.set({ status: 'error', message: e.message });
    }
  }

  async download() {
    if(this.downloadPending)return this.downloadPending;
    this.downloadPending=this._download();
    try{return await this.downloadPending}finally{this.downloadPending=null}
  }

  async _download() {
    const m = this.manifest;
    if (!m) throw Error('No verified update is available.');
    this.set({
      status: 'downloading',
      message: 'Downloading verified update…',
      version: m.version,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: m.bytes,
      speedBps: 0,
      mandatory: !!m.mandatory,
      notes: m.notes || '',
      sha256: m.sha256,
    });
    await fs.mkdir(this.root, { recursive: true });
    const ext = m.url.endsWith('.AppImage') ? '.AppImage' : m.url.endsWith('.tar.gz') ? '.tar.gz' : '.exe';
    const out = path.join(this.root, 'Forma-' + m.version + ext),
      tmp = out + '.' + process.pid + '.part';
    try {
      const existing = await fs.readFile(out);
      if (existing.length === m.bytes && crypto.createHash('sha256').update(existing).digest('hex') === m.sha256) {
        this.file = out;
        await pruneUpdateCache(this.root, { keepFile: out }).catch(() => {});
        return this.set({
          status: 'ready',
          message: 'Verified & ready to install.',
          progress: 100,
          downloadedBytes: m.bytes,
          totalBytes: m.bytes,
        });
      }
    } catch {}
    let file;
    try {
      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let existingSize = 0;
        try {
          const st = await fs.stat(tmp);
          if (st.size > 0 && st.size <= m.bytes) existingSize = st.size;
          else if (st.size > m.bytes) await fs.rm(tmp, { force: true });
        } catch {}
        try {
          if (existingSize === m.bytes) break;
          const headers = existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {};
          const r = await this.fetch(m.url, { headers, signal: AbortSignal.timeout(300000) });
          if (r.status === 416 && existingSize === m.bytes) break;
          if ((!r.ok && r.status !== 206) || !r.body) {
            const err = Error(`Update download failed (HTTP ${r.status}).`);
            err.retryable = r.status === 408 || r.status === 429 || r.status >= 500;
            throw err;
          }
          const finalUrl = new URL(r.url || m.url);
          const host = finalUrl.hostname.toLowerCase();
          if (finalUrl.protocol !== 'https:' || (host !== 'github.com' && !host.endsWith('.githubusercontent.com'))) {
            throw Error('Unexpected download host.');
          }
          const resuming = r.status === 206 && existingSize > 0;
          file = await fs.open(tmp, resuming ? 'a' : 'w', 0o600);
          let total = resuming ? existingSize : 0;
          const startTime = Date.now();
          let sessionBytes = 0;
          let lastEmit = 0;
          for await (const chunk of r.body) {
            total += chunk.length;
            sessionBytes += chunk.length;
            if (total > m.bytes) throw Error('The update exceeds its signed size.');
            await file.write(chunk);
            const now = Date.now();
            if (now - lastEmit > 120 || total === m.bytes) {
              lastEmit = now;
              const elapsed = Math.max(0.1, (now - startTime) / 1000);
              this.set({
                downloadedBytes: total,
                totalBytes: m.bytes,
                speedBps: Math.round(sessionBytes / elapsed),
                progress: Math.floor((total / m.bytes) * 100),
              });
            }
          }
          await file.close();
          file = null;
          if (total < m.bytes) {
            const err = Error('Update download ended early.');
            err.retryable = true;
            throw err;
          }
          lastErr = null;
          break;
        } catch (err) {
          if (file) {
            await file.close().catch(() => {});
            file = null;
          }
          lastErr = err;
          const transient = err?.retryable || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up|aborted|network|stream/i.test(String(err?.message || ''));
          if (!transient || attempt >= maxAttempts) throw err;
          this.set({ message: `Connection interrupted — resuming download (attempt ${attempt + 1}/${maxAttempts})…` });
          await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
        }
      }
      if (lastErr) throw lastErr;
      this.set({ status: 'verifying', message: 'Verifying SHA-256 & Ed25519 signature…', progress: 100 });
      const finalStat = await fs.stat(tmp);
      const finalBytes = await fs.readFile(tmp);
      if (finalStat.size !== m.bytes || crypto.createHash('sha256').update(finalBytes).digest('hex') !== m.sha256) {
        throw Error('Update checksum verification failed.');
      }
      await fs.rename(tmp, out);
      this.file = out;
      await pruneUpdateCache(this.root, { keepFile: out }).catch(() => {});
      return this.set({
        status: 'ready',
        message: 'Verified & ready to install.',
        progress: 100,
        downloadedBytes: m.bytes,
        totalBytes: m.bytes,
      });
    } catch (e) {
      if (file) await file.close().catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
      return this.set({ status: 'error', message: e.message });
    }
  }

  async install() {
    if (this.value.status !== 'ready' || !this.file || !this.manifest) throw Error('No verified update is ready.');
    const bytes = await fs.readFile(this.file);
    if (bytes.length !== this.manifest.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== this.manifest.sha256) {
      throw Error('The update file was modified.');
    }
    if (this.manifest.aud === 'forma-linux-x64') {
      await fs.chmod(this.file, 0o755).catch(() => {});
    }
    const launchArgs = this.manifest.aud === 'forma-linux-x64' ? [] : ['/S'];
    let executable=this.file,args=launchArgs;
    if(process.platform==='win32'&&this.restart?.path){
      await fs.access(this.restart.path);
      const sysRoot=process.env.SystemRoot||'C:\\Windows';
      const psExe=path.join(sysRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      executable=process.env.ComSpec||path.join(sysRoot,'System32','cmd.exe');
      args=['/d','/c',psExe,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',windowsUpdateCommand(this.file,this.manifest.sha256,this.restart.path,this.restart.args)];
    }
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    this.app.quit();
    return { ok: true };
  }
}

module.exports = { SignedUpdater, verifyRelease, newer, windowsUpdateCommand, pruneUpdateCache };
