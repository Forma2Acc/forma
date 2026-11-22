/**
 * Runtime proofs that need no Electron and no network.
 *
 *   node tools/test-runtime.mjs
 *
 * Covers: release envelope verification, semver ordering, and the protected
 * capability module's actual behaviour.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyRelease, compareSemver, parseSemver, RELEASE_DOMAIN } = require('../client/main/forma-updater.cjs');
const cap = require('../protected/module.cjs');

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed += 1;
}

// ── release envelope ────────────────────────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const release = {
  v: 1,
  version: '2.1.0',
  notes: 'Chats are archived before every switch.',
  publishedAt: Date.now(),
  assets: [{ platform: 'win32', arch: 'x64', url: 'https://example/FormaClaude-2.1.0.exe', sha256: 'a'.repeat(64), size: 1024 }],
};
const payload = JSON.stringify(release);
const signature = crypto.sign(null, Buffer.from(`${RELEASE_DOMAIN}\n${payload}`, 'utf8'), privateKey).toString('base64url');

const accepted = verifyRelease({ payload, signature }, publicKey);
ok('signed release verifies', accepted.version === '2.1.0');

const tampered = JSON.parse(payload);
tampered.assets[0].url = 'https://evil.example/x.exe';
let rejectedTamper = false;
try {
  verifyRelease({ payload: JSON.stringify(tampered), signature }, publicKey);
} catch {
  rejectedTamper = true;
}
ok('tampered release rejected', rejectedTamper);

let rejectedBadSig = false;
try {
  verifyRelease({ payload, signature: 'A'.repeat(86) }, publicKey);
} catch {
  rejectedBadSig = true;
}
ok('bad signature rejected', rejectedBadSig);

let rejectedSchema = false;
try {
  const p2 = JSON.stringify({ ...release, v: 9 });
  const s2 = crypto.sign(null, Buffer.from(`${RELEASE_DOMAIN}\n${p2}`, 'utf8'), privateKey).toString('base64url');
  verifyRelease({ payload: p2, signature: s2 }, publicKey);
} catch {
  rejectedSchema = true;
}
ok('unknown schema rejected', rejectedSchema);

// ── semver ──────────────────────────────────────────────────────────────────
ok('semver parses', parseSemver('2.0.0')?.minor === 0);
ok('2.0.1 > 2.0.0', compareSemver('2.0.1', '2.0.0') === 1);
ok('2.0.0 < 2.1.0', compareSemver('2.0.0', '2.1.0') === -1);
ok('equal versions', compareSemver('2.0.0', '2.0.0') === 0);
ok('release beats prerelease', compareSemver('2.0.0', '2.0.0-beta.1') === 1);
ok('garbage is not newer', compareSemver('nonsense', '2.0.0') === 0);

// ── windows ─────────────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
const t0 = Date.parse('2026-11-22T08:00:00Z');
const stamps = [t0, t0 + HOUR, t0 + 2 * HOUR, t0 + 6 * HOUR, t0 + 7 * HOUR];
const w = cap.windows(stamps);
ok('two windows for a 5h gap', w.length === 2, JSON.stringify(w.map((x) => x.count)));
ok('first window holds three messages', w[0].count === 3);

const blocked = cap.windowState(t0 + 3 * HOUR, stamps);
ok('window reports blocked inside 5h', blocked.blocked === true && blocked.used === 3);
const free = cap.windowState(t0 + 5 * HOUR + 1, stamps);
ok('window free after 5h', free.blocked === false);

// ── plan ────────────────────────────────────────────────────────────────────
const accounts = [
  { id: 'a', healthy: true, lastUsedAt: t0 - 2 * HOUR, resets: 0 },
  { id: 'b', healthy: true, lastUsedAt: t0 - 30 * HOUR, resets: 3 },
  { id: 'c', healthy: false, lastUsedAt: t0 - 100 * HOUR, resets: 0 },
];
const ranked = cap.rankAccounts(accounts);
ok('unhealthy account ranks last', ranked[ranked.length - 1].id === 'c');

const none = cap.plan({ quota: 'ok', accounts, now: t0 });
ok('quota ok means no action', none.action === 'none');

const cooling = cap.plan({ quota: 'limited', lastResetAt: t0 - 60_000, accounts, now: t0 });
ok('cooldown blocks an immediate reset', cooling.action === 'wait' && cooling.waitMs > 0);

const reset = cap.plan({ quota: 'limited', lastResetAt: t0 - 20 * 60_000, accounts, now: t0 });
ok('reset picks the healthiest account', reset.action === 'reset' && reset.account !== 'c');

const signup = cap.plan({ quota: 'limited', accounts: [], now: t0 });
ok('no accounts means signup', signup.action === 'signup');

const switched = cap.plan({ quota: 'blocked', accounts, now: t0 });
ok('blocked session switches account', switched.action === 'switch');

// ── redaction ───────────────────────────────────────────────────────────────
const dirty =
  'cookie: sessionKey=sk-ant-sid01-abcdefghijklmnop; token=abc; {"sessionKey":"leak","authorization":"Bearer abcdefghijklmnop"} 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const clean = cap.redact(dirty);
ok('session cookie redacted', !clean.includes('sk-ant-sid01-abcdefghijklmnop'));
ok('json secret redacted', !clean.includes('"leak"'));
ok('bearer redacted', !clean.includes('abcdefghijklmnop'));
ok('long hex shortened', !clean.includes('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'));
ok('non-secret text survives', cap.redact('archived 12 conversations').includes('archived 12 conversations'));

// ── archive budget ──────────────────────────────────────────────────────────
const b1 = cap.archiveBudget({ totalBytes: 10, conversations: 4, maxBytes: 100 });
ok('budget reports headroom', b1.exhausted === false && b1.remaining === 90);
const b2 = cap.archiveBudget({ totalBytes: 95, conversations: 400, maxBytes: 100 });
ok('budget winds down near the cap', b2.windDown === true && b2.exhausted === false);
const b3 = cap.archiveBudget({ totalBytes: 100, conversations: 500, maxBytes: 100 });
ok('budget exhausts exactly at the cap', b3.exhausted === true);

// ── describe ────────────────────────────────────────────────────────────────
ok('describe active', cap.describe({ status: 'active', accessType: 'pro' }) === 'Active · pro');
ok('describe expired', cap.describe({ status: 'expired' }) === 'Key expired');

console.log(failed ? `\n${failed} failed` : '\nall green');
process.exit(failed ? 1 : 0);
