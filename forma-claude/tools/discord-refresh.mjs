/**
 * Update the live Discord cards to the working 1.9.0 / 2.1.1 links.
 *
 *   node tools/discord-refresh.mjs
 *
 * Reads DISCORD_BOT_TOKEN from Railway (forma-core) in memory. Never prints it.
 */
import { execSync } from 'node:child_process';

const API = 'https://discord.com/api/v10';
const vars = JSON.parse(
  execSync('railway variables --json', {
    cwd: 'C:/Users/furaa/Desktop/Pylon/Neuer Ordner/Forma-Security/backend',
    encoding: 'utf8',
    shell: 'cmd.exe',
  }),
);
const TOKEN = vars.DISCORD_BOT_TOKEN;
if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN missing');

const LAUNCHER = 'https://github.com/Forma2Acc/forma/releases/latest/download/Forma-Setup-1.9.0.exe';
const RELEASE = 'https://github.com/Forma2Acc/forma/releases/tag/v1.9.0';
const CODE = 'https://github.com/Forma2Acc/forma/releases/tag/forma-code-v1.5.2';
const SITE = 'https://forma-claude-production.up.railway.app';

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const button = (label, url) => ({ type: 2, style: 5, label, url });
const row = (...components) => ({ type: 1, components });

const jobs = [
  {
    channel: '1573324366828011702',
    message: '1573684182582951978',
    embeds: [
      {
        title: 'Forma Launcher 1.9.0 — one window for the whole suite',
        description: [
          '**The Launcher is the front door.** It detects, installs, updates and starts Forma, Forma Code and Forma Claude — so you never hunt for an installer again.',
          '',
          '• Detects installed builds and shows their real versions',
          '• Installs or updates from the signed release channel',
          '• Verifies the Ed25519 manifest and the SHA-256 before anything runs',
          '• Rolls back automatically if an update fails to boot',
          '',
          '**Setup**',
          '1. Download **`Forma-Setup-1.9.0.exe`**.',
          '2. Run the per-user installer — no admin rights needed.',
          '3. Open `Forma` and enter your access key. Future updates apply automatically.',
          '',
          '**Setup SHA-256:** `9a9f0456621f14251de16117327f495348d6c29600f75b7264d36b78eb9c30df`',
        ].join('\n'),
        color: 0x60a5fa,
      },
    ],
    components: [
      row(button('Download Launcher 1.9.0', LAUNCHER)),
      row(button('Release notes', RELEASE), button('Forma Code', CODE)),
    ],
  },
  {
    channel: '1573324366828011702',
    message: '1573684160013275147',
    embeds: [
      {
        title: 'Forma · Official Windows Downloads (v1.9.0)',
        description: [
          '**Forma** is the desktop AI workspace built on Qwen: chat, agents, tools, MCP connections and skills in one native window.',
          '',
          '**Install**',
          '1. Download **`Forma-Setup-1.9.0.exe`** from GitHub Releases.',
          '2. Run the setup — it installs per user, no admin rights needed.',
          '3. Open Forma and paste your **Forma key** into the access gate.',
          '4. Future updates are signed, verified and installed automatically.',
          '',
          '**Requirements:** Windows 10/11, 64-bit, one valid key per PC.',
          '',
          '**Setup SHA-256:** `9a9f0456621f14251de16117327f495348d6c29600f75b7264d36b78eb9c30df`',
        ].join('\n'),
        color: 0x60a5fa,
      },
    ],
    components: [
      row(button('Download Forma v1.9.0', RELEASE), { type: 2, style: 2, label: 'Verify Checksum (Live)', custom_id: 'forma:info:release' }),
      row(
        button('🔑 Get Key', 'https://discord.com/channels/1570904679960027197/1573325977793331250'),
        button('📚 Guides', 'https://discord.com/channels/1570904679960027197/1571479417950048266'),
        button('📸 Proof Wall', 'https://discord.com/channels/1570904679960027197/1571577732180213790'),
      ),
    ],
  },
  {
    channel: '1574075049961586829',
    message: '1574075058429890702',
    embeds: [
      {
        title: 'Install Forma Claude',
        description: [
          '**1.** Install Claude Desktop from claude.ai, if you have not already.',
          '**2.** Open **Forma Launcher** and press **Install** on the Claude card — the launcher downloads, verifies and installs the signed payload for you.',
          '',
          '**Manual install**',
          'Download the zip, extract it, close Claude, then right-click `Install-FormaClaude.ps1` → *Run with PowerShell*.',
          '',
          'The original Claude bundle is backed up automatically. The uninstaller puts it back. Updates arrive through the launcher.',
        ].join('\n'),
        color: 0x2b2a28,
      },
    ],
    components: [row(button('Download latest', `${SITE}/download`), button('Get a key', `${SITE}/get-key`))],
  },
  {
    channel: '1574075052503343134',
    message: '1574075061688860807',
    embeds: [
      {
        title: 'Get a key',
        description: [
          '**1.** Open the key site.',
          '**2.** Open the checkpoint and finish the short ad page.',
          '**3.** If the tab does not come back, paste the address you landed on.',
          '**4.** Copy the `FORMA1.…` key into the lock screen.',
          '',
          'A key stays valid for **5 hours** and renews itself while Forma Claude is open. Already have a key? The site shows it again instead of asking you to repeat the checkpoint.',
        ].join('\n'),
        color: 0xc96f4a,
        footer: { text: 'Forma Claude' },
      },
    ],
    components: [row(button('Open the key site', `${SITE}/get-key`), button('Download', `${SITE}/download`))],
  },
];

for (const job of jobs) {
  await api('PATCH', `/channels/${job.channel}/messages/${job.message}`, {
    embeds: job.embeds,
    components: job.components,
  });
  console.log(`updated ${job.channel}/${job.message}`);
}
