/**
 * Proves two things that matter:
 *   1. the sealed module opens with the right lease and refuses the wrong one
 *   2. the chat merge is monotonic — nothing is ever dropped
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sealModule, openModule } = require('../client/main/forma-protected.cjs');
const { mergeConversation, messageText } = require('../client/main/forma-chat-store.cjs');

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed += 1;
}

// ── seal round-trip ──────────────────────────────────────────────────────────
const secret = crypto.randomBytes(32).toString('base64');
const device = 'dev-abc123';
const source = 'module.exports = { answer: 42, greet: (n) => "hi " + n };';
const file = './.tmp-test.fsl';

const info = sealModule({ source, leaseSecret: secret, deviceId: device, outFile: file });
ok('seal produced a blob', info.bytes > 60, `${info.bytes} bytes`);

const opened = openModule({ file, leaseSecret: secret, deviceId: device });
ok('seal opens with the right key', opened.answer === 42 && opened.greet('x') === 'hi x');

let wrongKey = false;
try {
  openModule({ file, leaseSecret: crypto.randomBytes(32).toString('base64'), deviceId: device });
} catch {
  wrongKey = true;
}
ok('seal refuses a wrong key', wrongKey);

let wrongDevice = false;
try {
  openModule({ file, leaseSecret: secret, deviceId: 'dev-other' });
} catch {
  wrongDevice = true;
}
ok('seal refuses a wrong device', wrongDevice);

// ── merge monotonicity ───────────────────────────────────────────────────────
const first = {
  uuid: 'c1',
  name: 'A',
  updatedAt: '2026-11-22T10:00:00Z',
  messages: [
    { role: 'user', text: 'one', at: '2026-11-22T09:59:00Z', index: 0, hash: 'h1' },
    { role: 'assistant', text: 'two', at: '2026-11-22T10:00:00Z', index: 1, hash: 'h2' },
  ],
};
const second = {
  uuid: 'c1',
  name: 'A',
  updatedAt: '2026-11-22T09:00:00Z', // older timestamp on purpose
  messages: [
    { role: 'user', text: 'one', at: '2026-11-22T09:59:00Z', index: 0, hash: 'h1' },
    { role: 'assistant', text: 'two', at: '2026-11-22T10:00:00Z', index: 1, hash: 'h2' },
    { role: 'user', text: 'three', at: '2026-11-22T10:05:00Z', index: 2, hash: 'h3' },
  ],
};
const merged = mergeConversation(first, second);
ok('merge keeps every message', merged.messages.length === 3);
ok('merge orders by time', merged.messages[2].text === 'three');
ok('merge keeps the newest updatedAt', merged.updatedAt === '2026-11-22T10:00:00Z');

const backwards = mergeConversation(merged, first);
ok('merge never shrinks', backwards.messages.length === 3);

// ── structured content ───────────────────────────────────────────────────────
const blocks = [
  { type: 'text', text: 'hello' },
  { type: 'thinking', thinking: 'considering' },
  { type: 'tool_use', name: 'search', input: { q: 'x' } },
  { type: 'tool_result', content: [{ type: 'text', text: 'result' }] },
  { type: 'image', source: { media_type: 'image/png', data: 'AAAA' } },
];
const text = messageText({ content: blocks });
ok('text blocks extracted', text.includes('hello'));
ok('thinking extracted', text.includes('considering'));
ok('tool_use extracted', text.includes('search'));
ok('tool_result extracted', text.includes('result'));
ok('image placeholder', text.includes('image/png'));

import fs from 'node:fs';
fs.unlinkSync(file);

console.log(failed ? `\n${failed} failed` : '\nall green');
process.exit(failed ? 1 : 0);
