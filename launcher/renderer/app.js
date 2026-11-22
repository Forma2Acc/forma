'use strict';
const api = window.forma;
const $ = (id) => document.getElementById(id);

const SOON = [
  { id: 'chatgpt', name: 'ChatGPT', vendor: 'OpenAI', icon: 'i-openai', desc: 'Desktop integration with your local tools.' },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', icon: 'i-codex', desc: 'Terminal and coding workflows in Forma.' },
  { id: 'gemini', name: 'Gemini', vendor: 'Google', icon: 'i-gemini', desc: 'Another model family. One familiar workspace.' }
];

let state = null;
let archive = null;
let running = false;

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4600);
}

function timeAgo(ts) {
  if (!ts) return 'â€”';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'min';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function setView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $('stage').scrollTop = 0;
  if (name === 'settings') renderPaths();
}

function spotlight(card) {
  card.addEventListener('pointermove', (event) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((event.clientX - rect.left) / rect.width) * 100 + '%');
    card.style.setProperty('--my', ((event.clientY - rect.top) / rect.height) * 100 + '%');
  });
}

function soonCard(model, index) {
  const card = document.createElement('article');
  card.className = 'card soon interactive';
  card.style.setProperty('--i', index + 1);
  card.tabIndex = 0;
  card.innerHTML =
    '<div class="card-top"><div class="mark"><svg viewBox="0 0 24 24"><use href="#' + model.icon + '"/></svg></div>' +
    '<span class="badge">Coming soon</span></div>' +
    '<div class="card-name"></div><div class="card-vendor"></div><p class="card-desc"></p>' +
    '<div class="card-foot"><span class="badge">In development</span></div><span class="soon-line"></span>';
  card.querySelector('.card-name').textContent = model.name;
  card.querySelector('.card-vendor').textContent = model.vendor;
  card.querySelector('.card-desc').textContent = model.desc;
  const notify = () => toast(model.name + ' is in development. Qwen is available now.');
  card.addEventListener('click', notify);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); notify(); } });
  spotlight(card);
  return card;
}

function qwenCard() {
  const card = document.createElement('article');
  card.className = 'card interactive';
  card.style.setProperty('--i', 0);
  card.tabIndex = 0;
  card.innerHTML =
    '<div class="card-top"><div class="mark"><svg viewBox="0 0 24 24"><use href="#i-qwen"/></svg></div>' +
    '<span class="badge" data-role="badge">â€”</span></div>' +
    '<div class="card-name">Qwen</div><div class="card-vendor">Alibaba Â· Desktop</div>' +
    '<p class="card-desc">Local tools and a continuous chat history. Open installation details.</p>' +
    '<div class="card-foot"><span class="badge ok">Available</span></div>';
  card.addEventListener('click', openDrawer);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(); });
  spotlight(card);
  return card;
}

function codeCard() {
  const card = document.createElement('article');
  card.className = 'card interactive';
  card.style.setProperty('--i', 1);
  card.tabIndex = 0;
  card.innerHTML =
    '<div class="card-top"><div class="mark"><svg viewBox="0 0 24 24"><use href="#i-opencode"/></svg></div>' +
    '<span class="badge" data-role="code-badge">—</span></div>' +
    '<div class="card-name">Forma Code</div><div class="card-vendor">OpenCode · Desktop</div>' +
    '<p class="card-desc">20-stage Limit Reset waterfall, encrypted vault, and auto-updating IDE workspace.</p>' +
    '<div class="card-foot"><span class="badge ok">Available</span></div>';
  const trigger = () => {
    if (state?.formaCode?.installed) act('code-launch');
    else act('code-install', { launch: true });
  };
  card.addEventListener('click', trigger);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') trigger(); });
  spotlight(card);
  return card;
}

function claudeCard() {
  const card = document.createElement('article');
  card.className = 'card interactive';
  card.style.setProperty('--i', 2);
  card.tabIndex = 0;
  card.innerHTML =
    '<div class="card-top"><div class="mark"><svg viewBox="0 0 24 24"><use href="#i-claude"/></svg></div>' +
    '<span class="badge" data-role="claude-badge">-</span></div>' +
    '<div class="card-name">Forma Claude</div><div class="card-vendor">Anthropic - Desktop</div>' +
    '<p class="card-desc">Claude Desktop with the Forma Limit Reset, automatic chat archive and a device-bound key.</p>' +
    '<div class="card-foot"><span class="badge ok">Available</span></div>';
  const trigger = () => {
    if (state?.claude?.installed) act('claude-launch');
    else act('claude-install', { launch: true });
  };
  card.addEventListener('click', trigger);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') trigger(); });
  spotlight(card);
  return card;
}

function buildGrids() {
  const soon = $('soonGrid');
  const all = $('allGrid');
  soon.replaceChildren();
  all.replaceChildren(qwenCard(), codeCard(), claudeCard());
  SOON.forEach((model, index) => {
    soon.append(soonCard(model, index));
    all.append(soonCard(model, index + 3));
  });
  $('modelCount').textContent = String(SOON.length + 3);
  $('modelsHint').textContent = '3 available - ' + SOON.length + ' in development';
}

function statusText() {
  if (!state) return { label: 'Checking', kind: '', detail: 'Qwen installation' };
  const q = state.qwen;
  if (!q.installed) return { label: 'Not installed', kind: 'warn', detail: 'Qwen was not found' };
  if (q.modded) return { label: 'Forma active', kind: 'ok', detail: 'Integration installed' + (q.running ? 'Â· running' : '') };
  if (q.stock) return { label: 'Update available', kind: 'warn', detail: 'Stock Qwen active' };
  return { label: 'Different build', kind: 'warn', detail: 'Unrecognized app.asar' };
}

function render() {
  if (!state) return;
  const q = state.qwen;
  const status = statusText();
  const badge = $('qwenBadge');
  badge.textContent = status.label;
  badge.className = 'badge ' + status.kind;
  const cardBadge = document.querySelector('#allGrid [data-role="badge"]');
  if (cardBadge) { cardBadge.textContent = status.label; cardBadge.className = 'badge ' + status.kind; }
  const fc = state.formaCode || {};
  const codeStatus = fc.installed
    ? { label: fc.running ? 'Running' : 'Installed', kind: 'ok' }
    : { label: 'Not installed', kind: 'warn' };
  if ($('codeBadge')) { $('codeBadge').textContent = codeStatus.label; $('codeBadge').className = 'badge ' + codeStatus.kind; }
  const codeCardBadge = document.querySelector('#allGrid [data-role="code-badge"]');
  if (codeCardBadge) { codeCardBadge.textContent = codeStatus.label; codeCardBadge.className = 'badge ' + codeStatus.kind; }
  if ($('cVersion')) $('cVersion').textContent = fc.version ? 'v' + fc.version : '—';
  if ($('cState')) $('cState').textContent = codeStatus.label;
  if ($('cRunning')) $('cRunning').textContent = fc.running ? 'Yes' : 'No';
  if ($('btnCodeInstallLabel')) $('btnCodeInstallLabel').textContent = fc.installed ? 'Update / Reinstall' : 'Install Forma Code';
  if ($('btnCodeLaunch')) $('btnCodeLaunch').disabled = running || !fc.installed;
  if ($('btnCodeInstall')) $('btnCodeInstall').disabled = running;

  const cl = state.claude || {};
  const clStatus = !cl.installed
    ? { label: 'Not installed', kind: 'warn' }
    : cl.patched
      ? { label: cl.running ? 'Running' : 'Installed', kind: 'ok' }
      : { label: 'Needs setup', kind: 'warn' };
  if ($('claudeBadge')) { $('claudeBadge').textContent = clStatus.label; $('claudeBadge').className = 'badge ' + clStatus.kind; }
  const clCardBadge = document.querySelector('#allGrid [data-role="claude-badge"]');
  if (clCardBadge) { clCardBadge.textContent = clStatus.label; clCardBadge.className = 'badge ' + clStatus.kind; }
  if ($('clVersion')) $('clVersion').textContent = cl.version ? 'v' + cl.version : '—';
  if ($('clState')) $('clState').textContent = clStatus.label;
  if ($('clChats')) $('clChats').textContent = cl.archive && cl.archive.available ? String(cl.archive.chats) : '0';
  const lic = state.license || {};
  const clKey = cl.key || {};
  const keyStatus = clKey.status && clKey.status !== 'none' ? clKey.status : 'none';
  const KEY_LABELS = {
    active: 'Active', expired: 'Expired', invalid: 'Invalid', offline: 'Offline',
    checking: 'Checking', stored: 'Key stored', none: 'Not activated'
  };
  const licLabel = KEY_LABELS[keyStatus] || (lic.status === 'active' ? 'Active' : 'Not activated');
  if ($('clLicense')) $('clLicense').textContent = licLabel;
  if ($('btnClaudeInstallLabel')) $('btnClaudeInstallLabel').textContent = cl.installed ? 'Update / Reinstall' : 'Install Claude';
  if ($('btnClaudeLaunch')) $('btnClaudeLaunch').disabled = running || !cl.installed;
  if ($('btnClaudeInstall')) $('btnClaudeInstall').disabled = running;
  if ($('btnClaudeSetup')) $('btnClaudeSetup').textContent = cl.installed ? 'Update Claude' : 'Install Claude';
  if ($('claudeSetupHint')) $('claudeSetupHint').textContent = cl.installed
    ? 'Claude Desktop is present. Reapply the signed Forma integration.'
    : 'Install Claude Desktop from claude.ai, then let Forma add the Limit Reset automatically.';
  if ($('btnClaudeRestore')) $('btnClaudeRestore').disabled = running || !cl.patched;
  const clDrawer = $('claudeDrawer');
  if (clDrawer) {
    if ($('clInstalled')) $('clInstalled').textContent = cl.installed ? 'Yes' : 'No';
    if ($('clBuild')) $('clBuild').textContent = cl.patched ? 'Installed' : 'Not installed';
    if ($('clRunning')) $('clRunning').textContent = cl.running ? 'Yes' : 'No';
    if ($('clBackup')) $('clBackup').textContent = cl.backup && cl.patched ? 'Available' : 'Missing';
    if ($('clHash')) $('clHash').textContent = cl.hash ? cl.hash.slice(0, 24) + ' ...' : 'No build';
    if ($('clExePath')) $('clExePath').textContent = cl.exe || state.paths.claudeExe || '';
    if ($('clAsarPath')) $('clAsarPath').textContent = cl.asar || state.paths.claudeAsar || '';
    const arc = cl.archive || {};
    if ($('clAChats')) $('clAChats').textContent = String(arc.chats || 0);
    if ($('clAMessages')) $('clAMessages').textContent = String(arc.messages || 0);
    if ($('clAAccounts')) $('clAAccounts').textContent = String(arc.accounts || 0);
    if ($('clAUpdated')) $('clAUpdated').textContent = arc.available ? timeAgo(arc.updated) : '—';
    if ($('clArchivePath')) $('clArchivePath').textContent = state.paths.claudeArchive || '';
    if ($('clKeyState')) $('clKeyState').textContent = licLabel;
    const dev = String(clKey.device || lic.device || '').trim().toUpperCase();
    if ($('clKeyDevice')) $('clKeyDevice').textContent = dev.length >= 8 ? `FRM-${dev.slice(0, 4)}-${dev.slice(4, 8)}` : 'Waiting';
    if ($('clKeyUrl')) $('clKeyUrl').textContent = state.paths.claudeKeyUrl || '';
    if ($('claudeDrawerSub')) $('claudeDrawerSub').textContent = 'Claude Desktop - ' + clStatus.label;
    if ($('clLaunch')) $('clLaunch').disabled = running || !cl.installed;
    if ($('clInstall')) $('clInstall').disabled = running;
    if ($('clRestore')) $('clRestore').disabled = running || !cl.patched;
  }

  $('railDot').className = 'dot ' + status.kind + (q.running ? ' live' : '');
  $('railStatus').textContent = q.installed ? 'Qwen ' + (q.version || '') : 'Qwen not found';
  $('railSub').textContent = status.detail;
  $('railVersion').textContent = 'Forma ' + state.launcher.version;
  const rawDev = String(state.license?.device || '').trim().toUpperCase();
  const formaId = rawDev.length >= 8 ? `FRM-${rawDev.slice(0, 4)}-${rawDev.slice(4, 8)}` : 'FRM-PENDING';
  if ($('railFormaId')) $('railFormaId').textContent = formaId;
  if ($('copyFormaId')) $('copyFormaId').dataset.copyId = formaId;
  if ($('settingsFormaId')) $('settingsFormaId').textContent = formaId;
  if ($('settingsDeviceHex')) $('settingsDeviceHex').textContent = rawDev ? `Full ID: ${rawDev.slice(0, 20)}…${rawDev.slice(-12)}` : 'Waiting for device binding…';
  if ($('settingsCopyId')) $('settingsCopyId').dataset.copyId = formaId;

  $('mVersion').textContent = q.version || 'â€”';
  $('mState').textContent = status.label;
  $('mChats').textContent = archive && archive.available ? String(archive.chats) : '0';
  $('mBackup').textContent = archive && archive.available ? timeAgo(archive.updated) : 'â€”';
  $('btnQwenSetup').textContent=q.installed?'Repair integration':'Download & install Qwen';
  $('qwenSetupHint').textContent=q.installed?'Qwen is installed. Reapply the verified Forma integration.':'Qwen is missing. Download and verify the official app, then set up Forma automatically.';
  $('btnInstallLabel').textContent = !q.installed ? 'Install Qwen and Forma' : q.modded ? 'Reinstall integration' : 'Install integration';
  $('homeHint').textContent = !q.installed ? 'Download Qwen and set up Forma automatically.' : q.modded ? 'Your Forma integration is up to date.' : 'Install the latest Forma integration.';

  $('dInstalled').textContent = q.installed ? 'Yes' : 'No';
  $('dBuild').textContent = q.modded ? 'Up to date' : (q.stock ? 'Not installed' : 'Different build');
  $('dRunning').textContent = q.running ? 'Yes' : 'No';
  $('dBackup').textContent = q.backupPresent ? 'Available' : 'Missing';
  $('dHash').textContent = q.buildHash ? q.buildHash.slice(0, 24) + ' â€¦' : 'No build';
  $('dExePath').textContent = state.paths.qwenExe;
  $('dAsarPath').textContent = state.paths.installedAsar;
  $('dArchivePath').textContent = state.paths.archive;
  $('drawerSub').textContent = 'Desktop Â· ' + status.label;

  if (archive) {
    $('dChats').textContent = String(archive.chats);
    $('dMessages').textContent = String(archive.messages);
    $('dAccounts').textContent = String(archive.accounts);
    $('dUpdated').textContent = archive.available ? timeAgo(archive.updated) : 'â€”';
  }
  $('infoLine').textContent = 'Forma ' + state.launcher.version + ' Â· Electron ' + state.launcher.electron + ' Â· Chromium ' + state.launcher.chrome;

  document.querySelectorAll('[data-setting]').forEach((el) => {
    const on = !!state.settings[el.dataset.setting];
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  });
  document.body.classList.toggle('no-motion', !state.settings.motion);

  for (const id of ['btnQwenSetup', 'btnLaunch', 'btnInstall', 'dLaunch', 'dInstall', 'dInstallOnly', 'btnRestore', 'dRestore']) {
    $(id).disabled = running || (!q.installed && !['btnQwenSetup','btnInstall','dInstall','dInstallOnly'].includes(id));
  }
  const isLinux = state.platform === 'linux';
  const restoreSetting = $('btnRestore').closest('.setting');
  if (restoreSetting) restoreSetting.hidden = isLinux;
  $('dRestore').hidden = isLinux;
}

function renderPaths() {
  if (!state) return;
  const rows = [
    ['Qwen installation', state.paths.qwen, 'qwen'],
    ['Chat archive', state.paths.archive, 'archive'],
    ['Working folder', state.paths.workspace, 'workspace'],
    ['Claude installation', state.paths.claude, 'claude'],
    ['Claude archive', state.paths.claudeArchive, 'claudeArchive']
  ];
  const host = $('paths');
  host.replaceChildren();
  for (const [label, value, key] of rows) {
    const row = document.createElement('div');
    row.className = 'setting';
    const copy = document.createElement('div');
    copy.className = 'setting-copy';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.className = 'path';
    span.textContent = value;
    copy.append(strong, span);
    const button = document.createElement('button');
    button.className = 'btn ghost';
    button.textContent = 'Open';
    button.dataset.reveal = key;
    button.addEventListener('click', () => api.reveal(key));
    row.append(copy, button);
    host.append(row);
  }
}

async function refresh() {
  try {
    const [next, arc] = await Promise.all([api.state(), api.archive()]);
    state = next;
    archive = arc;
    running = next.busy;
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function logLine(text, isError) {
  const box = $('console');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'line' + (isError ? ' err' : '');
  line.textContent = text;
  box.append(line);
  while (box.childElementCount > 400) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

function renderSteps(steps) {
  const host = $('steps');
  host.replaceChildren();
  steps.forEach((step, index) => {
    const row = document.createElement('div');
    row.className = 'step ' + step.state;
    const dot = document.createElement('div');
    dot.className = 'step-dot';
    const inner = document.createElement('span');
    inner.textContent = step.state === 'done' ? 'âœ“' : (step.state === 'error' ? '!' : String(index + 1));
    dot.append(inner);
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = step.title;
    body.append(title);
    if (step.detail) {
      const detail = document.createElement('div');
      detail.className = 'step-detail';
      detail.textContent = step.detail;
      body.append(detail);
    }
    row.append(dot, body);
    host.append(row);
  });
}

function openDrawer() { $('drawer').classList.add('open'); $('scrim').classList.add('open'); refresh(); }
function closeDrawer() { $('drawer').classList.remove('open'); $('claudeDrawer').classList.remove('open'); $('scrim').classList.remove('open'); }
function openClaudeDrawer() { $('claudeDrawer').classList.add('open'); $('scrim').classList.add('open'); refresh(); }

function claudeInstallAction() {
  if (state?.claude?.installed) act('claude-install', { launch: state?.settings?.launchAfterInstall });
  else api.claudeDownload().then(() => toast('Install Claude Desktop from claude.ai, then press Install Claude again.')).catch((e) => toast(e.message, true));
}

async function act(kind, options) {
  if (running) { toast('An operation is already running.'); return; }
  running = true;
  render();
  const isJob = ['install', 'restore', 'code-install', 'claude-install', 'claude-restore'].includes(kind);
  if (isJob) {
    setView('activity');
    $('console').replaceChildren();
    $('jobTitle').textContent = kind === 'install'
      ? 'Set up Qwen and Forma'
      : kind === 'code-install'
        ? 'Install / Update Forma Code'
        : kind === 'claude-install'
          ? 'Install / Update Forma Claude'
          : kind === 'claude-restore'
            ? 'Restore original Claude'
            : 'Restore original';
    $('jobState').textContent = 'Running…';
  }
  try {
    const result = kind === 'install' ? await api.install(options)
      : kind === 'code-install' ? await api.codeInstall(options)
      : kind === 'code-launch' ? await api.codeLaunch()
      : kind === 'claude-install' ? await api.claudeInstall(options)
      : kind === 'claude-launch' ? await api.claudeLaunch()
      : kind === 'claude-restore' ? await api.claudeRestore()
      : kind === 'restore' ? await api.restore()
      : await api.launch();
    if (result && result.ok === false) toast(result.error || 'The operation failed.', true);
    else if (result && result.skipped) toast('Claude Desktop is not installed yet.');
    else if (kind === 'launch') toast('Starting Qwen.');
    else if (kind === 'code-launch') toast('Starting Forma Code.');
    else if (kind === 'claude-launch') toast('Starting Claude.');
    else if (kind === 'claude-restore') toast('Original Claude bundle restored.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    running = false;
    await refresh();
  }
}

api.onProgress((payload) => {
  if (!payload) return;
  if (payload.kind === 'window') return;
  if (payload.steps) renderSteps(payload.steps);
  if (payload.phase === 'log' && payload.line) logLine(payload.line);
  if (payload.phase === 'error') {
    $('jobState').textContent = 'Failed';
    logLine(payload.message, true);
    toast(payload.message, true);
  }
  if (payload.phase === 'done') {
    $('jobState').textContent = 'Completed';
    logLine(payload.message);
    toast(payload.message);
  }
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-window]').forEach((button) => button.addEventListener('click', () => api.window(button.dataset.window)));
document.querySelectorAll('[data-setting]').forEach((button) => button.addEventListener('click', async () => {
  const key = button.dataset.setting;
  const next = !state.settings[key];
  state.settings = await api.settings({ [key]: next });
  render();
}));
document.querySelectorAll('[data-reveal]').forEach((button) => button.addEventListener('click', () => api.reveal(button.dataset.reveal)));
document.querySelectorAll('[data-help]').forEach((button) => button.addEventListener('click', () => api.help(button.dataset.help).catch(e=>toast(e.message,true))));

$('btnLaunch').addEventListener('click', (event) => { event.stopPropagation(); act('launch'); });
$('btnInstall').addEventListener('click', (event) => { event.stopPropagation(); act('install', { launch: state.settings.launchAfterInstall }); });
$('btnDetails').addEventListener('click', (event) => { event.stopPropagation(); openDrawer(); });
$('qwenFeature').addEventListener('click', openDrawer);
$('qwenFeature').addEventListener('keydown', (event) => { if (event.key === 'Enter') openDrawer(); });
if ($('btnCodeLaunch')) $('btnCodeLaunch').addEventListener('click', (event) => { event.stopPropagation(); act('code-launch'); });
if ($('btnCodeInstall')) $('btnCodeInstall').addEventListener('click', (event) => { event.stopPropagation(); act('code-install', { launch: state?.settings?.launchAfterInstall }); });
if ($('codeFeature')) {
  $('codeFeature').addEventListener('click', () => state?.formaCode?.installed ? act('code-launch') : act('code-install', { launch: true }));
  spotlight($('codeFeature'));
}
if ($('claudeFeature')) {
  $('claudeFeature').addEventListener('click', (event) => { if (!event.target.closest('button')) openClaudeDrawer(); });
  $('claudeFeature').addEventListener('keydown', (event) => { if (event.key === 'Enter') openClaudeDrawer(); });
  spotlight($('claudeFeature'));
}
if ($('btnClaudeLaunch')) $('btnClaudeLaunch').addEventListener('click', (event) => { event.stopPropagation(); act('claude-launch'); });
if ($('btnClaudeInstall')) $('btnClaudeInstall').addEventListener('click', (event) => { event.stopPropagation(); claudeInstallAction(); });
if ($('btnClaudeKey')) $('btnClaudeKey').addEventListener('click', (event) => { event.stopPropagation(); api.claudeKey().catch((e) => toast(e.message, true)); });
if ($('btnClaudeSetup')) $('btnClaudeSetup').addEventListener('click', () => claudeInstallAction());
if ($('btnClaudeRestore')) $('btnClaudeRestore').addEventListener('click', () => act('claude-restore'));
if ($('claudeDrawerClose')) $('claudeDrawerClose').addEventListener('click', closeDrawer);
if ($('clLaunch')) $('clLaunch').addEventListener('click', () => act('claude-launch'));
if ($('clInstall')) $('clInstall').addEventListener('click', () => claudeInstallAction());
if ($('clRestore')) $('clRestore').addEventListener('click', () => { closeDrawer(); act('claude-restore'); });
if ($('clKey')) $('clKey').addEventListener('click', () => api.claudeKey().catch((e) => toast(e.message, true)));
if ($('clBuyKey')) $('clBuyKey').addEventListener('click', () => api.claudeKey().catch((e) => toast(e.message, true)));
if ($('clActivate')) $('clActivate').addEventListener('click', async () => {
  const input = $('clKeyInput');
  const value = String(input?.value || '').trim();
  if (!value) { toast('Paste your Forma key first.', true); input?.focus(); return; }
  try {
    const res = await api.claudeActivate(value);
    if (res && res.ok === false) { toast(res.error || 'The key could not be activated.', true); return; }
    if (input) input.value = '';
    toast(res?.launched ? 'Key sent to Claude. Claude is starting to activate it.' : 'Key sent to Claude. It activates the next time Claude starts.');
    setTimeout(refresh, 1200);
  } catch (error) {
    toast(error.message, true);
  }
});
if ($('clKeyInput')) $('clKeyInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('clActivate').click(); });
if ($('clOpenArchive')) $('clOpenArchive').addEventListener('click', () => api.claudeOpen('archive').then((r) => { if (r && r.ok === false) toast(r.error, true); }));
if ($('clOpenDir')) $('clOpenDir').addEventListener('click', () => api.claudeOpen('dir').then((r) => { if (r && r.ok === false) toast(r.error, true); }));
$('dLaunch').addEventListener('click', () => act('launch'));
$('dInstall').addEventListener('click', () => { closeDrawer(); act('install', { launch: true }); });
$('dInstallOnly').addEventListener('click', () => { closeDrawer(); act('install', { launch: false }); });
$('dRestore').addEventListener('click', () => { closeDrawer(); act('restore'); });
$('btnRestore').addEventListener('click', () => act('restore'));
$('drawerClose').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
for (const copyBtnId of ['copyFormaId', 'settingsCopyId']) {
  const el = $(copyBtnId);
  if (el) {
    el.addEventListener('click', async () => {
      const code = el.dataset.copyId || '';
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        toast(`Copied Forma ID: ${code}`);
      } catch {
        toast(`Forma ID: ${code}`);
      }
    });
  }
}
spotlight($('qwenFeature'));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
  if (event.ctrlKey && ['1', '2', '3', '4'].includes(event.key)) {
    event.preventDefault();
    setView(['home', 'models', 'activity', 'settings'][Number(event.key) - 1]);
  }
});
window.addEventListener('focus', refresh);

buildGrids();
refresh();
setInterval(refresh, 6000);

let lastUpdateState = null;
let updateDismissedVersion = '';
let manualUpdateCheck = false;

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function renderUpdateScreen(s) {
  if (!s) return;
  lastUpdateState = s;
  const screen = $('updateScreen');
  if (!screen) return;

  const activeStatuses = manualUpdateCheck
    ? ['checking', 'available', 'downloading', 'verifying', 'ready', 'error']
    : ['available', 'downloading', 'verifying', 'ready'];
  if (s.status === 'current' || s.status === 'ready') manualUpdateCheck = false;
  const ver = s.availableVersion || (s.manifest && s.manifest.version) || s.version || '';
  const dismissed = !s.mandatory && !s.autoApplying && ver && updateDismissedVersion === ver && s.status === 'available';

  if (!activeStatuses.includes(s.status) || dismissed) {
    screen.hidden = true;
    return;
  }
  screen.hidden = false;
  const curVer = ($('railVersion') && $('railVersion').textContent.replace(/^Forma\s+/i, '')) || '';
  $('upTitle').textContent = s.status === 'checking'
    ? 'Checking for updates…'
    : s.status === 'error'
      ? 'Update could not be completed'
      : s.status === 'ready'
        ? (s.autoApplying ? 'Applying update & restarting…' : 'Update ready to install')
    : s.status === 'downloading'
      ? 'Updating Forma automatically…'
      : s.status === 'verifying'
        ? 'Verifying cryptographic signature…'
        : s.mandatory
          ? 'Required update available'
          : 'New Forma update available';
  $('upVersion').textContent = ver ? `${curVer || 'Current'} -> v${ver}${s.mandatory ? ' (Required)' : ''}` : 'Release check';

  const notesEl = $('upNotes');
  const notesText = String(s.notes || (s.manifest && s.manifest.notes) || '').trim();
  if (notesText) {
    notesEl.textContent = notesText;
    notesEl.hidden = false;
  } else {
    notesEl.hidden = true;
  }

  const pct = s.status === 'ready' || s.status === 'verifying'
    ? 100
    : Math.max(0, Math.min(100, Number(s.progress) || 0));
  $('upProgressBar').style.width = pct + '%';
  $('upStatusText').textContent = s.message || 'Checking update…';

  const metrics = [];
  if (s.totalBytes > 0) metrics.push(`${formatBytes(s.downloadedBytes || 0)} / ${formatBytes(s.totalBytes)}`);
  if (s.speedBps > 0 && s.status === 'downloading') metrics.push(formatBytes(s.speedBps) + '/s');
  metrics.push(pct + '%');
  $('upMetrics').textContent = metrics.join(' · ');

  $('upVerify').textContent = s.status === 'ready'
    ? 'Verified: SHA-256 & Ed25519 signature valid'
    : s.status === 'verifying'
      ? 'Checking SHA-256 checksum & Ed25519 signature…'
      : 'Signed via GitHub + Railway OTA (SHA-256 + Ed25519)';

  const actBtn = $('upActionBtn');
  const laterBtn = $('upLaterBtn');
  laterBtn.hidden = !!s.mandatory || !!s.autoApplying || ['downloading', 'verifying', 'ready'].includes(s.status);
  if (s.status === 'downloading' || s.status === 'verifying') {
    actBtn.disabled = true;
    actBtn.textContent = s.status === 'verifying' ? 'Verifying…' : 'Downloading…';
  } else if (s.status === 'ready') {
    actBtn.disabled = !!s.autoApplying;
    actBtn.textContent = s.autoApplying ? 'Restarting automatically…' : 'Update & Restart';
  } else if (s.status === 'checking') {
    actBtn.disabled = true;
    actBtn.textContent = 'Checking…';
  } else if (s.status === 'error') {
    actBtn.disabled = false;
    actBtn.textContent = 'Retry update check';
  } else {
    actBtn.disabled = false;
    actBtn.textContent = 'Download update';
  }
}

$('upActionBtn').addEventListener('click', () => {
  if (!window.formaUpdates) { toast('The update service is unavailable.', true); return; }
  if (!lastUpdateState) { window.formaUpdates.check({autoDownload:false}).then(renderUpdateScreen).catch((e) => toast(e.message, true)); return; }
  if (lastUpdateState.status === 'ready') {
    window.formaUpdates.install().catch((e) => toast(e.message, true));
  } else if (lastUpdateState.status === 'available' && typeof window.formaUpdates.download === 'function') {
    window.formaUpdates.download().then(renderUpdateScreen).catch((e) => toast(e.message, true));
  } else {
    window.formaUpdates.check({autoDownload:false}).then(renderUpdateScreen).catch((e) => toast(e.message, true));
  }
});
$('upLaterBtn').addEventListener('click', () => {
  if (lastUpdateState && lastUpdateState.mandatory) return;
  updateDismissedVersion = (lastUpdateState && (lastUpdateState.availableVersion || (lastUpdateState.manifest && lastUpdateState.manifest.version))) || '';
  $('updateScreen').hidden = true;
});

if (window.formaUpdates) {
  window.formaUpdates.onState(renderUpdateScreen);
  if (typeof window.formaUpdates.onApplyError === 'function') {
    window.formaUpdates.onApplyError((err) => {
      if (err && err.message) toast('Update setup: ' + err.message, true);
    });
  }
  if (typeof window.formaUpdates.state === 'function') {
    window.formaUpdates.state().then(renderUpdateScreen).catch(() => {});
  }
}
if (window.formaLicense && typeof window.formaLicense.onState === 'function') {
  window.formaLicense.onState((lic) => {
    const lr = lic && lic.policy && lic.policy.latestRelease;
    if (lr && lr.version && (!lastUpdateState || lastUpdateState.status === 'current' || lastUpdateState.status === 'idle')) {
      window.formaUpdates && window.formaUpdates.check({ autoDownload: true }).then(renderUpdateScreen).catch(() => {});
    }
  });
}

const updateCheck = document.createElement('button');
updateCheck.className = 'btn';
updateCheck.textContent = 'Check for launcher updates';
updateCheck.style.marginTop = '14px';
updateCheck.onclick = () => {
  updateDismissedVersion = '';
  manualUpdateCheck = true;
  updateCheck.disabled = true;
  window.formaUpdates && window.formaUpdates.check({autoDownload:true}).then((s) => {
    renderUpdateScreen(s);
    if (s && s.status === 'current') toast(s.message || 'Forma is up to date.');
  }).catch((e) => toast(e.message, true)).finally(()=>{updateCheck.disabled=false;});
};
const settingsView = document.getElementById('view-settings');
if (settingsView) settingsView.append(updateCheck);
document.getElementById('btnConnections').onclick=async()=>{const b=document.getElementById('btnConnections');b.disabled=true;try{const r=await api.connections();if(!r.ok)throw Error(r.error);toast('Connections are opening in Qwen.');}catch(e){toast(e.message,true);}finally{b.disabled=false;}};

document.getElementById('btnQwenSetup').onclick=()=>act('install',{launch:state.settings.launchAfterInstall});
