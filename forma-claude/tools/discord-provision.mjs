/**
 * Forma Claude — Discord provisioning.
 *
 * Creates the Claude lane next to the OpenCode lane, with the same permission
 * shape, then posts the launch messages. Safe to run repeatedly: everything is
 * found by name and every message has a marker.
 *
 *   node tools/discord-provision.mjs --dry-run
 *   node tools/discord-provision.mjs
 *
 * Env
 *   DISCORD_BOT_TOKEN   required (never pass on the command line)
 *   DISCORD_GUILD_ID    required
 *   FORMA_SITE          key site origin
 *   DOWNLOAD_URL        installer zip (defaults to <site>/downloads/FormaClaude-2.1.0.zip)
 *   ANNOUNCE            1 to post in #announcements
 *
 * Node fetch only. PowerShell Invoke-RestMethod is blocked by Cloudflare (40333).
 */

const API = 'https://discord.com/api/v10';
const DRY = process.argv.includes('--dry-run');

const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD = process.env.DISCORD_GUILD_ID || '';
const SITE = (process.env.FORMA_SITE || '').replace(/\/+$/, '');
const DOWNLOAD =
  process.env.DOWNLOAD_URL || (SITE ? `${SITE}/downloads/FormaClaude-2.1.0.zip` : '');
const ANNOUNCE = process.env.ANNOUNCE === '1';

const CATEGORY_NAME = '⚡ CLAUDE LIMIT BYPASS';
const MAIN_NAME = '⚡・claude-limit-bypass';
const DOWNLOAD_NAME = '📥・downloads';
const KEY_NAME = '🔑・get-key';
const CATEGORY_POSITION = Number(process.env.CATEGORY_POSITION || 7);

// Copied from the OpenCode lane so the two sections behave identically.
const OVERWRITES = [
  { id: '1570911671851946014', type: 0, allow: '326417902656', deny: '0' },
  { id: '1571088501053591554', type: 0, allow: '274878295104', deny: '0' },
  { id: '1570909364821172399', type: 0, allow: '274878295104', deny: '0' },
  { id: '1570911472073056397', type: 0, allow: '66624', deny: '377957124096' },
  { id: '1570904679960027197', type: 0, allow: '0', deny: '377957125120' },
];

function fail(message) {
  console.error(`  ${message}`);
  process.exit(1);
}

if (!DRY) {
  if (!TOKEN) fail('DISCORD_BOT_TOKEN is required (or pass --dry-run).');
  if (!GUILD) fail('DISCORD_GUILD_ID is required.');
  if (!SITE) fail('FORMA_SITE is required, e.g. https://forma.example');
  if (!DOWNLOAD) fail('DOWNLOAD_URL could not be derived.');
}

async function discord(method, route, body) {
  if (DRY) {
    console.log(`  [dry] ${method} ${route}${body ? ` ${JSON.stringify(body).slice(0, 100)}` : ''}`);
    return method === 'GET'
      ? []
      : { id: `dry-${String(body?.name || 'x').replace(/[^a-z0-9]+/gi, '-')}`, name: body?.name };
  }
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bot ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'FormaPublisher/2.0 (https://forma.example, 2.0)',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) {
    const info = await res.json().catch(() => ({}));
    const wait = Math.min(10_000, Math.ceil((info.retry_after || 1) * 1000));
    await new Promise((r) => setTimeout(r, wait));
    return discord(method, route, body);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const listChannels = () => discord('GET', `/guilds/${GUILD}/channels`);

async function ensureCategory() {
  const list = await listChannels();
  const found = list.find((c) => c.type === 4 && c.name === CATEGORY_NAME);
  if (found) return found;
  return discord('POST', `/guilds/${GUILD}/channels`, {
    name: CATEGORY_NAME,
    type: 4,
    position: CATEGORY_POSITION,
    permission_overwrites: OVERWRITES,
  });
}

async function ensureChannel({ name, parent_id, topic, position }) {
  const list = await listChannels();
  const found = list.find((c) => c.parent_id === parent_id && c.name === name);
  if (found) return found;
  return discord('POST', `/guilds/${GUILD}/channels`, {
    name,
    type: 0,
    parent_id,
    topic,
    position,
    permission_overwrites: OVERWRITES,
  });
}

async function postOnce(channelId, body, marker) {
  if (DRY) {
    console.log(`  [dry] message in ${channelId}: ${marker}`);
    return null;
  }
  const messages = await discord('GET', `/channels/${channelId}/messages?limit=100`);
  if (messages.some((m) => String(m.content || '').includes(marker))) {
    console.log(`  "${marker}" already present`);
    return null;
  }
  return discord('POST', `/channels/${channelId}/messages`, body);
}

const link = (label, url) => ({ type: 2, style: 5, label, url });

const main = async () => {
  console.log(DRY ? '  dry run — nothing will be created' : '  provisioning the Claude lane…');

  const category = await ensureCategory();
  const mainChannel = await ensureChannel({
    name: MAIN_NAME,
    parent_id: category.id,
    position: 0,
    topic: 'Forma Claude — Limit Reset for Claude Desktop. Download, then get a key.',
  });
  const downloads = await ensureChannel({
    name: DOWNLOAD_NAME,
    parent_id: category.id,
    position: 1,
    topic: 'Forma Claude installer and release notes.',
  });
  const getKey = await ensureChannel({
    name: KEY_NAME,
    parent_id: category.id,
    position: 2,
    topic: 'Get a Forma Claude key. One key, one device.',
  });

  await postOnce(
    mainChannel.id,
    {
      embeds: [
        {
          title: 'Forma Claude 2.1.0',
          description: [
            '**Limit Reset** inside Claude Desktop.',
            '',
            '· Your chats are archived before every account switch',
            '· Restore any archived conversation later',
            '· One key per device, signed auto-updates',
            '· Windows 10/11, x64',
            '',
            `Install with the button below, then get a key in <#${getKey.id}>.`,
          ].join('\n'),
          color: 0xc96442,
          footer: { text: 'Forma Claude' },
        },
      ],
      components: [
        { type: 1, components: [link('Download 2.1.0', DOWNLOAD)] },
        { type: 1, components: [link('Get a key', `${SITE}/get-key`)] },
      ],
    },
    'Forma Claude 2.1.0',
  );

  await postOnce(
    downloads.id,
    {
      embeds: [
        {
          title: 'Install',
          description: [
            '**1.** Install Claude Desktop from claude.ai, if you have not already.',
            '**2.** Close Claude.',
            '**3.** Download the zip and extract it.',
            '**4.** Right-click `Install-FormaClaude.ps1` → *Run with PowerShell*.',
            '**5.** Start Claude and paste your key on the lock screen.',
            '',
            'The original Claude bundle is backed up automatically. The uninstaller puts it back.',
          ].join('\n'),
          color: 0x2b2a28,
        },
      ],
      components: [{ type: 1, components: [link('Download 2.1.0', DOWNLOAD)] }],
    },
    'Install',
  );

  await postOnce(
    getKey.id,
    {
      embeds: [
        {
          title: 'Get a key',
          description: [
            '**1.** Open the key site.',
            '**2.** Open the checkpoint and finish the short ad page.',
            '**3.** Come back to the key tab and paste the address you landed on.',
            '**4.** Copy the `FORMA1.…` key into the lock screen.',
            '',
            'One key binds to the first device that activates it. One key per installation per day.',
          ].join('\n'),
          color: 0xc96442,
          footer: { text: 'Forma Claude' },
        },
      ],
      components: [{ type: 1, components: [link('Open the key site', `${SITE}/get-key`)] }],
    },
    'Get a key',
  );

  if (ANNOUNCE) {
    const list = await listChannels();
    const ann = list.find((c) => c.name.includes('announcements'));
    if (ann) {
      await postOnce(
        ann.id,
        {
          embeds: [
            {
              title: 'Forma Claude is live',
              description: [
                'Limit Reset for Claude Desktop, with chat archiving and restore.',
                '',
                `Download and keys: <#${mainChannel.id}>`,
              ].join('\n'),
              color: 0xc96442,
            },
          ],
        },
        'Forma Claude is live',
      );
    }
  }

  console.log('');
  console.log(
    JSON.stringify(
      {
        category: category.id,
        main: mainChannel.id,
        downloads: downloads.id,
        getKey: getKey.id,
      },
      null,
      2,
    ),
  );
  if (!DRY) console.log('\n  done.');
};

main().catch((err) => {
  console.error(`\n  ${err.message}`);
  process.exit(1);
});
