/**
 * Publish a signed release.
 *
 *   node tools/publish-release.mjs --file dist/FormaClaude-Setup-2.1.0.exe --version 2.1.0 \
 *     --notes "Chats are archived before every switch." \
 *     --api https://forma-claude-production.up.railway.app --admin ops
 *
 * Password comes from FORMA_ADMIN_PASSWORD. Never pass it on the command line:
 * it lands in shell history and process lists.
 */
import { publishRelease } from './publish-lib.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = arg('file');
const version = arg('version');
const api = arg('api', process.env.FORMA_API_URL || 'http://127.0.0.1:8791');
const adminPath = arg('admin', process.env.ADMIN_PATH || 'admin');
const password = process.env.FORMA_ADMIN_PASSWORD || '';

if (!file || !version) {
  console.error('usage: node tools/publish-release.mjs --file <artifact> --version <x.y.z> [--notes text] [--api url] [--admin path]');
  process.exit(1);
}
if (!password) {
  console.error('FORMA_ADMIN_PASSWORD is required.');
  process.exit(1);
}

try {
  const out = await publishRelease({
    api,
    adminPath,
    password,
    file,
    version,
    notes: arg('notes', ''),
    platform: arg('platform', 'win32'),
    arch: arg('arch', 'x64'),
    mandatory: process.argv.includes('--mandatory'),
    minVersion: arg('min-version', '0.0.0'),
  });
  console.log(`published ${out.version}`);
  console.log(`  asset   ${out.name}  ${out.size} bytes`);
  console.log(`  sha256  ${out.sha256}`);
  console.log(`  signed  ${out.envelope.signature.slice(0, 24)}…`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
